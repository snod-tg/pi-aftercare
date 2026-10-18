export interface Actor {
  merchantId: string;
  customerId: string;
}

export interface Variant {
  id: string;
  productId: string;
  name: string;
  size: string;
  stock: number;
  version: number;
}

export interface OrderLine {
  id: string;
  variantId: string;
  name: string;
  quantity: number;
  requestedQuantity: number;
  paidUnitCents: number;
}

export interface Order {
  id: string;
  merchantId: string;
  customerId: string;
  status: "delivered" | "pending";
  deliveredAt: string;
  currency: "CNY";
  version: number;
  lines: OrderLine[];
}

export interface Policy {
  version: string;
  returnWindowDays: number;
  quoteTtlMinutes: number;
  source: string;
  clauses: Array<{ id: string; text: string }>;
}

export type AftercareAction =
  | { kind: "return"; lineId: string; quantity: number }
  | { kind: "exchange"; lineId: string; quantity: number; targetVariantId: string };

export interface Quote {
  id: string;
  merchantId: string;
  customerId: string;
  orderId: string;
  orderVersion: number;
  policyVersion: string;
  inventoryVersions: Record<string, number>;
  actions: AftercareAction[];
  refundCents: number;
  currency: "CNY";
  createdAt: string;
  expiresAt: string;
  confirmationRequired: true;
}

export interface Confirmation {
  idempotencyKey: string;
  id: string;
  quoteId: string;
  customerId: string;
  merchantId: string;
  confirmedAt: string;
}

export interface AftercareRequest {
  id: string;
  merchantId: string;
  customerId: string;
  orderId: string;
  quoteId: string;
  confirmationId: string;
  idempotencyKey: string;
  actions: AftercareAction[];
  refundCents: number;
  currency: "CNY";
  status: "awaiting_return";
  refundStatus: "not_started";
  createdAt: string;
}

export interface Operation {
  fingerprint: string;
  requestId: string;
}

export interface DemoState {
  policy: Policy;
  orders: Map<string, Order>;
  variants: Map<string, Variant>;
  quotes: Map<string, Quote>;
  confirmations: Map<string, Confirmation>;
  requests: Map<string, AftercareRequest>;
  operations: Map<string, Operation>;
}
