import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AftercareService } from "../domain/aftercare.js";
import { DomainError } from "../domain/errors.js";
import type { Actor, Quote } from "../domain/types.js";
import { createConnectedModel, type ModelConnection } from "./model-connection.js";
import { createAftercareSession } from "./session.js";

export interface RunLimits {
  maxModelCalls: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export function readRunLimits(env: NodeJS.ProcessEnv = process.env): RunLimits {
  const read = (name: string, fallback: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
    return value;
  };
  return {
    maxModelCalls: read("AGENT_MAX_MODEL_CALLS", 8),
    maxToolCalls: read("AGENT_MAX_TOOL_CALLS", 24),
    timeoutMs: read("AGENT_TIMEOUT_MS", 120_000),
  };
}

export interface ConfirmationReceipt {
  quoteId: string;
  confirmationId: string;
  idempotencyKey: string;
}

export interface TraceEvent {
  time: string;
  type: "text" | "tool_start" | "tool_end";
  text?: string;
  tool?: string;
  ok?: boolean;
}

export interface RunResult {
  status: "completed" | "model_error" | "model_limit" | "tool_limit" | "timeout" | "cancelled";
  text: string;
  error?: string;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  trace: TraceEvent[];
  pendingQuotes: Quote[];
  operations: ReturnType<AftercareService["getOperation"]>[];
}

type StopReason = Exclude<RunResult["status"], "completed" | "model_error">;

export class AgentConversation {
  private session!: AgentSession;
  private readonly quotes = new Map<string, Quote>();
  private readonly receipts = new Map<string, ConfirmationReceipt>();
  private busy = false;
  private disposed = false;
  private reason: StopReason | undefined;
  private modelCalls = 0;
  private toolCalls = 0;

  private constructor(
    private readonly service: AftercareService,
    private readonly actor: Actor,
    private readonly connection: ModelConnection,
    private readonly limits: RunLimits,
  ) {}

  static async create(options: {
    service: AftercareService;
    actor: Actor;
    connection: ModelConnection;
    limits?: RunLimits;
    fetch?: typeof globalThis.fetch;
  }) {
    const limits = { ...readRunLimits({}), ...options.limits };
    if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error("运行限制必须是正整数");
    }
    const conversation = new AgentConversation(options.service, Object.freeze({ ...options.actor }), options.connection, limits);
    const { modelRuntime, model } = await createConnectedModel(options.connection);
    const { session } = await createAftercareSession({
      service: options.service,
      actor: options.actor,
      modelRuntime,
      model,
      toolHooks: {
        beforeTool: () => conversation.beforeTool(),
        onQuote: (quote) => {
          for (const [id, old] of conversation.quotes) {
            if (old.orderId === quote.orderId) conversation.quotes.delete(id);
          }
          conversation.quotes.set(quote.id, quote);
        },
        authorizeCreate: (input) => {
          const receipt = conversation.receipts.get(input.quoteId);
          if (!conversation.quotes.has(input.quoteId) || !receipt || receipt.confirmationId !== input.confirmationId || receipt.idempotencyKey !== input.idempotencyKey) {
            throw new DomainError("USER_CONFIRMATION_REQUIRED", "需要应用记录的当前方案确认，不能由模型或聊天文字生成", 409);
          }
        },
      },
    });
    conversation.session = session;
    const originalStream = session.agent.streamFunction;
    session.agent.streamFunction = (selectedModel, context, streamOptions) => {
      if (conversation.reason) throw new Error(conversation.reason);
      if (conversation.modelCalls >= limits.maxModelCalls) {
        conversation.reason = "model_limit";
        throw new Error("本轮模型请求次数已达上限");
      }
      conversation.modelCalls += 1;
      return originalStream(selectedModel, context, {
        ...streamOptions,
        maxTokens: options.connection.maxOutputTokens,
        maxRetries: 0,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    };
    return conversation;
  }

  private beforeTool() {
    if (!this.busy || this.reason) throw new Error("当前轮次已停止，不能继续执行工具");
    if (this.toolCalls >= this.limits.maxToolCalls) {
      this.stop("tool_limit");
      throw new Error("本轮工具执行次数已达上限");
    }
    this.toolCalls += 1;
  }

  private ensureReady() {
    if (this.disposed) throw new Error("会话已关闭");
    if (this.busy) throw new Error("上一轮仍在执行，请先等待或取消");
  }

  pendingQuotes() {
    return [...this.quotes.values()].filter((quote) => {
      const receipt = this.receipts.get(quote.id);
      return !receipt || this.service.getOperation(this.actor, receipt.idempotencyKey).status !== "completed";
    }).map((quote) => structuredClone(quote));
  }

  // This method is for a deliberate host/UI action, never registered as a model tool.
  confirm(quoteId: string): ConfirmationReceipt {
    this.ensureReady();
    if (!this.quotes.has(quoteId)) throw new DomainError("UNKNOWN_QUOTE", "该方案不属于本会话的当前方案", 404);
    const previous = this.receipts.get(quoteId);
    if (previous) return { ...previous };
    const confirmation = this.service.confirmQuote(this.actor, quoteId);
    const receipt = { quoteId, confirmationId: confirmation.id, idempotencyKey: `OP-${randomUUID()}` };
    this.receipts.set(quoteId, receipt);
    return { ...receipt };
  }

  async confirmAndContinue(quoteId: string, onEvent?: (event: TraceEvent) => void) {
    const receipt = this.confirm(quoteId);
    return this.run(`应用已记录用户对下列方案的明确确认：\n${JSON.stringify(receipt)}\n请使用上述标识继续处理，先查询已有操作结果，必要时创建申请。`, onEvent);
  }

  private stop(reason: StopReason) {
    this.reason ??= reason;
    // Synchronously signal cancellation; never wait for idle from an Agent event handler.
    this.session.agent.abort();
  }

  cancel() {
    if (this.busy) this.stop("cancelled");
  }

  async run(prompt: string, onEvent?: (event: TraceEvent) => void): Promise<RunResult> {
    this.ensureReady();
    if (!prompt.trim() || prompt.length > 4000) throw new Error("每条消息须为 1–4000 个字符");
    if (this.session.getSessionStats().totalMessages >= 80) throw new Error("会话历史已较长，请使用 /reset 开始新会话");
    this.busy = true;
    this.reason = undefined;
    this.modelCalls = 0;
    this.toolCalls = 0;
    const trace: TraceEvent[] = [];
    let text = "";
    let failure: string | undefined;
    const tokensBefore = this.session.getSessionStats().tokens.total;
    const emit = (event: Omit<TraceEvent, "time">) => {
      const entry = { ...event, time: new Date().toISOString() };
      if (trace.length < 120) trace.push(entry);
      onEvent?.(entry);
    };
    const unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        emit({ type: "text", text: event.assistantMessageEvent.delta });
      } else if (event.type === "tool_execution_start") {
        emit({ type: "tool_start", tool: event.toolName });
      } else if (event.type === "tool_execution_end") {
        emit({ type: "tool_end", tool: event.toolName, ok: !event.isError });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        if (event.message.stopReason === "error") failure = event.message.errorMessage ?? "模型 API 请求失败";
        if (event.message.stopReason === "length") failure = "模型输出达到上限，本轮结果可能不完整";
      }
    });
    const timer = setTimeout(() => this.stop("timeout"), this.limits.timeoutMs);
    try {
      await this.session.prompt(prompt, { expandPromptTemplates: false });
    } catch (error) {
      failure = error instanceof Error ? error.message : "模型 API 请求失败";
    } finally {
      clearTimeout(timer);
      unsubscribe();
      this.busy = false;
    }
    if (failure && this.connection.apiKey !== "local") failure = failure.replaceAll(this.connection.apiKey, "[redacted]");
    return {
      status: this.reason ?? (failure ? "model_error" : "completed"),
      text,
      ...(failure ? { error: failure.slice(0, 500) } : {}),
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      tokens: this.session.getSessionStats().tokens.total - tokensBefore,
      trace,
      pendingQuotes: this.pendingQuotes(),
      // Read back actual business results even if inference failed after a write.
      operations: [...this.receipts.values()].map((receipt) => this.service.getOperation(this.actor, receipt.idempotencyKey)),
    };
  }

  async close() {
    if (this.disposed) return;
    if (this.busy) { this.cancel(); await this.session.abort(); }
    this.session.dispose();
    this.disposed = true;
  }
}
