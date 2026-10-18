import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AftercareBackend } from "../domain/backend.js";
import { DomainError } from "../domain/errors.js";
import { CreateRequestSchema, LineLookupSchema, OperationLookupSchema, OrderIdSchema, QuoteInputSchema } from "../domain/schemas.js";
import type { Actor, Quote } from "../domain/types.js";

export interface ToolHooks {
  beforeTool?: () => void;
  onQuote?: (quote: Quote) => void;
  authorizeCreate?: (input: { quoteId: string; confirmationId: string; idempotencyKey: string }) => void;
}

async function result<T>(run: () => T | Promise<T>) {
  try {
    const data = await run();
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
  } catch (error) {
    if (error instanceof DomainError) throw new Error(`${error.code}: ${error.message}`, { cause: error });
    throw error;
  }
}

export function createAftercareTools(service: AftercareBackend, actor: Actor, hooks: ToolHooks = {}) {
  const identity = Object.freeze({ ...actor });
  const run = <T>(fn: () => T) => result(() => { hooks.beforeTool?.(); return fn(); });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  return [
    defineTool({
      name: "get_order", label: "查询订单", description: "查询当前已绑定客户的订单，不能访问其他客户订单。金额单位为分。",
      parameters: OrderIdSchema, annotations: readOnly,
      execute: async (_id, params) => run(() => service.getOrder(identity, params.orderId)),
    }),
    defineTool({
      name: "get_aftercare_policy", label: "查询售后政策", description: "获取本模拟商家对该订单适用的售后规则、版本及条款。",
      parameters: OrderIdSchema, annotations: readOnly,
      execute: async (_id, params) => run(() => service.getPolicy(identity, params.orderId)),
    }),
    defineTool({
      name: "list_variants", label: "查询尺码库存", description: "查询订单某件商品的同款尺码及当前库存；不保证提交时库存仍然可用。",
      parameters: LineLookupSchema, annotations: readOnly,
      execute: async (_id, params) => run(() => service.listVariants(identity, params.orderId, params.lineId)),
    }),
    defineTool({
      name: "quote_aftercare", label: "生成售后方案", description: "为当前订单的退货/换尺码请求报价。不扣库存，不创建申请。方案有效期内仍需用户单独确认。",
      parameters: QuoteInputSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, executionMode: "sequential",
      execute: async (_id, params) => run(async () => {
        const quote = await service.quote(identity, params.orderId, params.actions);
        hooks.onQuote?.(structuredClone(quote));
        return quote;
      }),
    }),
    defineTool({
      name: "create_aftercare_request", label: "创建售后申请", description: "仅凭用户确认接口返回的 confirmationId 提交方案。幂等键标识同一业务操作，重试必须复用。申请成功表示等待寄回，不表示退款完成。",
      parameters: CreateRequestSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, executionMode: "sequential",
      execute: async (_id, params) => run(() => {
        hooks.authorizeCreate?.(params);
        return service.createRequest(identity, params);
      }),
    }),
    defineTool({
      name: "get_request_status", label: "查询操作结果", description: "使用原业务幂等键查询操作是否已完成；请求超时后先查询，避免重复创建。",
      parameters: OperationLookupSchema, annotations: readOnly,
      execute: async (_id, params) => run(() => service.getOperation(identity, params.idempotencyKey)),
    }),
  ];
}
