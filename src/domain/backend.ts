import type {
  Actor,
  AftercareAction,
  AftercareRequest,
  Confirmation,
  CreateRequestInput,
  Order,
  Policy,
  Quote,
  Variant,
} from './types.js';

type Awaitable<T> = T | Promise<T>;

export type OperationResult =
  | { status: 'completed'; request: AftercareRequest }
  | { status: 'not_found' };

export interface SessionReadQuery {
  orderIds: readonly string[];
  operationKeys: readonly string[];
  quotes: readonly Quote[];
}

export interface SessionBusinessData {
  orders: ReadonlyMap<string, Order>;
  completedRequests: readonly AftercareRequest[];
  targetSizes: ReadonlyMap<string, string>;
}

export interface AftercareBackend {
  getOrder(actor: Actor, orderId: string): Awaitable<Order>;
  getPolicy(actor: Actor, orderId: string): Awaitable<Policy>;
  listVariants(actor: Actor, orderId: string, lineId: string): Awaitable<Variant[]>;
  listPendingQuotes(actor: Actor): Awaitable<Quote[]>;
  quote(actor: Actor, orderId: string, actions: AftercareAction[]): Awaitable<Quote>;
  confirmQuote(actor: Actor, quoteId: string): Awaitable<Confirmation>;
  getRequest(actor: Actor, requestId: string): Awaitable<AftercareRequest>;
  getOperation(actor: Actor, idempotencyKey: string): Awaitable<OperationResult>;
  createRequest(actor: Actor, input: CreateRequestInput): Awaitable<AftercareRequest>;
  readSessionData(actor: Actor, query: SessionReadQuery): Awaitable<SessionBusinessData>;
}
