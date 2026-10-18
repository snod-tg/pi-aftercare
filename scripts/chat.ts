import "dotenv/config";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { AgentConversation, readRunLimits, type RunResult, type TraceEvent } from "../src/agent/conversation.js";
import { readModelConnection } from "../src/agent/model-connection.js";
import { createBusinessRuntime } from "../src/storage/runtime.js";
import { DEMO_ALICE } from "../src/domain/seed.js";

const help = `输入售后需求开始对话，示例：订单 O-1001，T 恤换 L 码，外套退掉。
/quotes                查看本会话的当前方案
/confirm <方案ID>       明确确认指定方案，并让 Agent 继续
/reset                 清空对话历史，保留本次进程的业务状态
/quit                  退出
Ctrl+C                 取消当前模型调用；已完成的业务操作仍然有效`;

if (process.argv.includes("--help")) {
  console.log(help);
} else {
  let conversation: AgentConversation | undefined;
  let runtime: Awaited<ReturnType<typeof createBusinessRuntime>> | undefined;
  let rl: ReturnType<typeof createInterface> | undefined;
  try {
    const connection = readModelConnection();
    runtime = await createBusinessRuntime();
    const service = runtime.service;
    const create = () => AgentConversation.create({ service, actor: DEMO_ALICE, connection, restorePendingQuotes: runtime!.persistent, limits: readRunLimits() });
    conversation = await create();
    console.log(`Pi Aftercare → ${connection.baseUrl} / ${connection.modelName}`);
    console.log("模拟客户 Alice；模型服务需独立启动。\n" + help);
    rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY), prompt: "你> " });
    rl.on("SIGINT", () => { conversation?.cancel(); console.log("\n已请求取消；可继续输入或 /quit 退出。"); });
    const onEvent = (event: TraceEvent) => {
      if (event.type === "text") stdout.write(event.text ?? "");
      if (event.type === "tool_start") console.log(`\n[工具] ${event.tool}`);
      if (event.type === "tool_end" && !event.ok) console.log(`[工具失败] ${event.tool}`);
    };
    const show = async (result: RunResult) => {
      console.log(`\n[${result.status}] 模型请求 ${result.modelCalls} 次，工具执行 ${result.toolCalls} 次，Token ${result.tokens}`);
      if (result.error) console.log(result.error);
      for (const quote of result.pendingQuotes) {
        const order = await service.getOrder(DEMO_ALICE, quote.orderId);
        const items = quote.actions.map((action) => {
          const name = order.lines.find((line) => line.id === action.lineId)?.name ?? action.lineId;
          return action.kind === "return" ? `${name} ×${action.quantity} 退货` : `${name} ×${action.quantity} 换为 ${action.targetVariantId}`;
        });
        console.log(`\n待确认方案 ${quote.id}\n${items.join("；")}\n退款 ¥${(quote.refundCents / 100).toFixed(2)}；政策 ${quote.policyVersion}；有效期至 ${quote.expiresAt}`);
        console.log(`确认请输入：/confirm ${quote.id}`);
      }
      for (const operation of result.operations) {
        if (operation.status === "completed") console.log(`[业务回执] ${operation.request.id}：${operation.request.status}，退款状态 ${operation.request.refundStatus}`);
      }
    };
    rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (line === "/quit") break;
      try {
        if (line === "/help") console.log(help);
        else if (line === "/quotes") console.log(JSON.stringify(await conversation.pendingQuotes(), null, 2));
        else if (line === "/reset") {
          await conversation.close();
          conversation = await create();
          console.log(runtime!.persistent ? "已新建对话；数据库保留业务数据，当前有效方案可用 /quotes 查看。" : "已新建对话；本进程内的业务数据仍保留，退出后重置。");
        } else if (line.startsWith("/confirm ")) await show(await conversation.confirmAndContinue(line.slice(9).trim(), onEvent));
        else if (line.startsWith("/")) console.log("未知命令，输入 /help 查看。");
        else if (line) await show(await conversation.run(line, onEvent));
      } catch (error) { console.log(error instanceof Error ? error.message : "本轮执行失败"); }
      rl.prompt();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "无法初始化 Agent");
    process.exitCode = 1;
  } finally {
    rl?.close();
    await conversation?.close();
    await runtime?.close();
  }
}
