import { randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import { createDemoState } from "./seed.js";
import type { Actor, AftercareAction, AftercareRequest, DemoState, Order, Quote, Variant } from "./types.js";

type CreateRequestInput = { quoteId: string; confirmationId: string; idempotencyKey: string };

function requireId(value: string, label: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    throw new DomainError("INVALID_ID", `${label} 必须是 1–120 字符的非空字符串`);
  }
}

export class AftercareService {
  // Synchronous operations have no await points: validate everything before committing mutations.
  // This is a single-process simulator, not a durable or multi-process transaction implementation.
  constructor(
    private readonly state: DemoState = createDemoState(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private owned<T extends Actor>(value: T | undefined, actor: Actor, label: string): T {
    if (!value || value.merchantId !== actor.merchantId || value.customerId !== actor.customerId) {
      throw new DomainError("NOT_FOUND", `${label}不存在或不属于当前客户`, 404);
    }
    return value;
  }

  private order(actor: Actor, orderId: string) {
    requireId(orderId, "orderId");
    return this.owned(this.state.orders.get(orderId), actor, "订单");
  }

  getOrder(actor: Actor, orderId: string) {
    return structuredClone(this.order(actor, orderId));
  }

  getPolicy(actor: Actor, orderId: string) {
    this.order(actor, orderId);
    return structuredClone(this.state.policy);
  }

  listVariants(actor: Actor, orderId: string, lineId: string) {
    const order = this.order(actor, orderId);
    const line = order.lines.find((item) => item.id === lineId);
    if (!line) throw new DomainError("INVALID_LINE", "订单中不存在此商品");
    const original = this.state.variants.get(line.variantId);
    if (!original) throw new DomainError("VARIANT_UNAVAILABLE", "原商品信息缺失", 409);
    return structuredClone([...this.state.variants.values()].filter((item) => item.productId === original.productId));
  }

  private eligible(order: Order) {
    if (order.status !== "delivered") throw new DomainError("ORDER_NOT_ELIGIBLE", "仅支持已签收订单", 409);
    const elapsed = this.now().getTime() - Date.parse(order.deliveredAt);
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > this.state.policy.returnWindowDays * 86_400_000) {
      throw new DomainError("OUTSIDE_WINDOW", "订单不在本商家的退换货期限内", 409);
    }
  }

  quote(actor: Actor, orderId: string, actions: AftercareAction[]): Quote {
    const order = this.order(actor, orderId);
    this.eligible(order);
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 20) {
      throw new DomainError("INVALID_ACTIONS", "一次方案需要包含 1–20 项操作");
    }
    const seen = new Set<string>();
    const inventoryVersions: Record<string, number> = {};
    const targetQuantities = new Map<string, number>();
    let refundCents = 0;
    for (const action of actions) {
      if (seen.has(action.lineId)) throw new DomainError("DUPLICATE_LINE", "同一商品行只能出现一次");
      seen.add(action.lineId);
      const line = order.lines.find((item) => item.id === action.lineId);
      if (!line) throw new DomainError("INVALID_LINE", "订单中不存在此商品");
      if (!Number.isSafeInteger(action.quantity) || action.quantity < 1 || action.quantity > line.quantity - line.requestedQuantity) {
        throw new DomainError("INVALID_QUANTITY", "数量必须是正整数，且不得超过尚未申请售后的数量");
      }
      if (action.kind === "return") {
        refundCents += line.paidUnitCents * action.quantity;
      } else if (action.kind === "exchange") {
        const original = this.state.variants.get(line.variantId);
        const target = this.state.variants.get(action.targetVariantId);
        if (!original || !target || original.productId !== target.productId || target.id === original.id) {
          throw new DomainError("INVALID_EXCHANGE", "仅支持同款不同尺码换货");
        }
        const total = (targetQuantities.get(target.id) ?? 0) + action.quantity;
        targetQuantities.set(target.id, total);
        if (target.stock < total) throw new DomainError("OUT_OF_STOCK", "目标尺码库存不足", 409);
        inventoryVersions[target.id] = target.version;
      } else {
        throw new DomainError("INVALID_ACTION", "不支持的售后操作");
      }
    }
    if (!Number.isSafeInteger(refundCents)) throw new DomainError("INVALID_AMOUNT", "退款金额超出有效范围");
    const createdAt = this.now();
    const quote: Quote = {
      id: `Q-${randomUUID()}`,
      ...actor,
      orderId,
      orderVersion: order.version,
      policyVersion: this.state.policy.version,
      inventoryVersions,
      actions: structuredClone(actions),
      refundCents,
      currency: order.currency,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.state.policy.quoteTtlMinutes * 60_000).toISOString(),
      confirmationRequired: true,
    };
    this.state.quotes.set(quote.id, quote);
    return structuredClone(quote);
  }

  private currentQuote(actor: Actor, quoteId: string) {
    requireId(quoteId, "quoteId");
    const quote = this.owned(this.state.quotes.get(quoteId), actor, "方案");
    const order = this.order(actor, quote.orderId);
    if (Date.parse(quote.expiresAt) <= this.now().getTime()) throw new DomainError("QUOTE_EXPIRED", "方案已过期，请重新报价并确认", 409);
    if (quote.orderVersion !== order.version || quote.policyVersion !== this.state.policy.version) {
      throw new DomainError("QUOTE_STALE", "订单或政策已变化，请重新报价并确认", 409);
    }
    this.eligible(order);
    for (const [variantId, version] of Object.entries(quote.inventoryVersions)) {
      if (this.state.variants.get(variantId)?.version !== version) {
        throw new DomainError("QUOTE_STALE", "库存已变化，请重新报价并确认", 409);
      }
    }
    return quote;
  }

  // Called by the explicit customer confirmation endpoint; never exposed as an Agent tool.
  confirmQuote(actor: Actor, quoteId: string) {
    const quote = this.currentQuote(actor, quoteId);
    const confirmation = {
      id: `CF-${randomUUID()}`,
      ...actor,
      quoteId: quote.id,
      confirmedAt: this.now().toISOString(),
    };
    this.state.confirmations.set(confirmation.id, confirmation);
    return structuredClone(confirmation);
  }

  private operationScope(actor: Actor, idempotencyKey: string) {
    requireId(idempotencyKey, "idempotencyKey");
    return JSON.stringify([actor.merchantId, actor.customerId, idempotencyKey]);
  }

  getRequest(actor: Actor, requestId: string) {
    return structuredClone(this.owned(this.state.requests.get(requestId), actor, "售后申请"));
  }

  getOperation(actor: Actor, idempotencyKey: string) {
    const operation = this.state.operations.get(this.operationScope(actor, idempotencyKey));
    return operation
      ? { status: "completed" as const, request: this.getRequest(actor, operation.requestId) }
      : { status: "not_found" as const };
  }

  createRequest(actor: Actor, input: CreateRequestInput): AftercareRequest {
    requireId(input.quoteId, "quoteId");
    requireId(input.confirmationId, "confirmationId");
    const scope = this.operationScope(actor, input.idempotencyKey);
    const fingerprint = JSON.stringify([input.quoteId, input.confirmationId]);
    const previous = this.state.operations.get(scope);
    // A committed operation must remain replayable even after the quote expires or state changes.
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", "相同幂等键不能用于不同方案或确认记录", 409);
      return this.getRequest(actor, previous.requestId);
    }
    this.owned(this.state.quotes.get(input.quoteId), actor, "方案");
    if ([...this.state.requests.values()].some((request) => request.quoteId === input.quoteId)) {
      throw new DomainError("QUOTE_ALREADY_USED", "方案已提交，请查询原申请", 409);
    }
    const quote = this.currentQuote(actor, input.quoteId);
    const confirmation = this.owned(this.state.confirmations.get(input.confirmationId), actor, "确认记录");
    if (confirmation.quoteId !== quote.id) throw new DomainError("CONFIRMATION_MISMATCH", "确认记录不属于当前方案", 409);

    const nextOrder = structuredClone(this.order(actor, quote.orderId));
    const nextVariants = new Map<string, Variant>();
    for (const action of quote.actions) {
      const line = nextOrder.lines.find((item) => item.id === action.lineId);
      if (!line || action.quantity > line.quantity - line.requestedQuantity) {
        throw new DomainError("QUOTE_STALE", "可售后数量已变化，请重新报价", 409);
      }
      line.requestedQuantity += action.quantity;
      if (action.kind === "exchange") {
        const target = nextVariants.get(action.targetVariantId) ?? structuredClone(this.state.variants.get(action.targetVariantId));
        if (!target || target.stock < action.quantity) throw new DomainError("OUT_OF_STOCK", "目标尺码库存不足", 409);
        target.stock -= action.quantity;
        target.version += 1;
        nextVariants.set(target.id, target);
      }
    }
    nextOrder.version += 1;
    const request: AftercareRequest = {
      id: `R-${randomUUID()}`,
      ...actor,
      orderId: quote.orderId,
      quoteId: quote.id,
      confirmationId: confirmation.id,
      idempotencyKey: input.idempotencyKey,
      actions: structuredClone(quote.actions),
      refundCents: quote.refundCents,
      currency: quote.currency,
      status: "awaiting_return",
      refundStatus: "not_started",
      createdAt: this.now().toISOString(),
    };
    this.state.orders.set(nextOrder.id, nextOrder);
    for (const [id, variant] of nextVariants) this.state.variants.set(id, variant);
    this.state.requests.set(request.id, request);
    this.state.operations.set(scope, { fingerprint, requestId: request.id });
    return structuredClone(request);
  }

  // Simulation controls used by tests; these are not HTTP endpoints or Agent tools.
  setStockForDemo(variantId: string, stock: number) {
    const variant = this.state.variants.get(variantId);
    if (!variant || !Number.isSafeInteger(stock) || stock < 0) throw new DomainError("INVALID_STOCK", "无效模拟库存");
    this.state.variants.set(variantId, { ...variant, stock, version: variant.version + 1 });
  }
}
