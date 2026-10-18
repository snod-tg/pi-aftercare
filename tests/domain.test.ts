import assert from "node:assert/strict";
import test from "node:test";
import { AftercareService } from "../src/domain/aftercare.js";
import { DomainError } from "../src/domain/errors.js";
import { createDemoState, DEMO_ALICE, DEMO_BOB } from "../src/domain/seed.js";
import type { AftercareAction } from "../src/domain/types.js";

const mixed: AftercareAction[] = [
  { kind: "exchange", lineId: "LINE-TEE", quantity: 1, targetVariantId: "SKU-TEE-L" },
  { kind: "return", lineId: "LINE-JACKET", quantity: 1 },
];
const teeReturn: AftercareAction[] = [{ kind: "return", lineId: "LINE-TEE", quantity: 1 }];

function setup() {
  let time = new Date("2026-10-18T04:00:00Z");
  const state = createDemoState(time);
  const service = new AftercareService(state, () => time);
  return { service, state, advance: (ms: number) => { time = new Date(time.getTime() + ms); } };
}

function fails(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);
}

test("mixed exchange and partial return use paid cents and only reserve replacement stock", () => {
  const { service, state } = setup();
  const quote = service.quote(DEMO_ALICE, "O-1001", mixed);
  assert.equal(quote.refundCents, 19900);
  assert.equal(state.variants.get("SKU-TEE-L")?.stock, 2);
  assert.equal(state.requests.size, 0);
  const confirmation = service.confirmQuote(DEMO_ALICE, quote.id);
  const request = service.createRequest(DEMO_ALICE, { quoteId: quote.id, confirmationId: confirmation.id, idempotencyKey: "mixed-1" });
  assert.equal(request.status, "awaiting_return");
  assert.equal(request.refundStatus, "not_started");
  assert.equal(state.variants.get("SKU-TEE-L")?.stock, 1);
  assert.equal(state.variants.get("SKU-TEE-M")?.stock, 10);
  assert.deepEqual(service.getOrder(DEMO_ALICE, "O-1001").lines.map((line) => line.requestedQuantity), [1, 1]);
});

test("unknown confirmation cannot create an application", () => {
  const { service, state } = setup();
  const quote = service.quote(DEMO_ALICE, "O-1001", teeReturn);
  fails(() => service.createRequest(DEMO_ALICE, { quoteId: quote.id, confirmationId: "invented", idempotencyKey: "op" }), "NOT_FOUND");
  assert.equal(state.requests.size, 0);
  assert.equal(service.getOrder(DEMO_ALICE, "O-1001").version, 1);
});

test("resource checks conceal other customers' orders and quotes", () => {
  const { service } = setup();
  fails(() => service.getOrder(DEMO_BOB, "O-1001"), "NOT_FOUND");
  fails(() => service.getOrder({ ...DEMO_ALICE, merchantId: "other" }, "O-1001"), "NOT_FOUND");
  const quote = service.quote(DEMO_ALICE, "O-1001", teeReturn);
  fails(() => service.confirmQuote(DEMO_BOB, quote.id), "NOT_FOUND");
});

test("reject invalid quantities and duplicate lines", () => {
  const { service } = setup();
  for (const quantity of [0, -1, 0.5, 2, NaN, Infinity]) {
    fails(() => service.quote(DEMO_ALICE, "O-1001", [{ kind: "return", lineId: "LINE-TEE", quantity }]), "INVALID_QUANTITY");
  }
  fails(() => service.quote(DEMO_ALICE, "O-1001", [...teeReturn, ...teeReturn]), "DUPLICATE_LINE");
});

test("reject empty actions, other products, same SKU and unavailable sizes", () => {
  const { service } = setup();
  fails(() => service.quote(DEMO_ALICE, "O-1001", []), "INVALID_ACTIONS");
  for (const targetVariantId of ["SKU-JACKET-M", "SKU-TEE-M", "unknown"]) {
    fails(() => service.quote(DEMO_ALICE, "O-1001", [{ kind: "exchange", lineId: "LINE-TEE", quantity: 1, targetVariantId }]), "INVALID_EXCHANGE");
  }
  fails(() => service.quote(DEMO_ALICE, "O-1001", [{ kind: "exchange", lineId: "LINE-TEE", quantity: 1, targetVariantId: "SKU-TEE-XL" }]), "OUT_OF_STOCK");
});

test("policy window and delivery state are enforced by the service", () => {
  const { service, state } = setup();
  const order = state.orders.get("O-1001")!;
  order.status = "pending";
  fails(() => service.quote(DEMO_ALICE, "O-1001", teeReturn), "ORDER_NOT_ELIGIBLE");
  order.status = "delivered";
  order.deliveredAt = "2026-01-01T00:00:00Z";
  fails(() => service.quote(DEMO_ALICE, "O-1001", teeReturn), "OUTSIDE_WINDOW");
});

test("inventory changes after customer confirmation require a new quote", () => {
  const { service, state } = setup();
  const quote = service.quote(DEMO_ALICE, "O-1001", mixed);
  const confirmation = service.confirmQuote(DEMO_ALICE, quote.id);
  service.setStockForDemo("SKU-TEE-L", 0);
  fails(() => service.createRequest(DEMO_ALICE, { quoteId: quote.id, confirmationId: confirmation.id, idempotencyKey: "op" }), "QUOTE_STALE");
  assert.equal(state.requests.size, 0);
  assert.equal(service.getOrder(DEMO_ALICE, "O-1001").version, 1);
  assert.equal(service.getOperation(DEMO_ALICE, "op").status, "not_found");
});

test("an expired quote cannot be confirmed or executed", () => {
  const { service, advance } = setup();
  const quote = service.quote(DEMO_ALICE, "O-1001", teeReturn);
  const confirmation = service.confirmQuote(DEMO_ALICE, quote.id);
  advance(10 * 60_000);
  fails(() => service.confirmQuote(DEMO_ALICE, quote.id), "QUOTE_EXPIRED");
  fails(() => service.createRequest(DEMO_ALICE, { quoteId: quote.id, confirmationId: confirmation.id, idempotencyKey: "expired" }), "QUOTE_EXPIRED");
});

test("policy changes invalidate old confirmations", () => {
  const { service, state } = setup();
  const quote = service.quote(DEMO_ALICE, "O-1001", teeReturn);
  const confirmation = service.confirmQuote(DEMO_ALICE, quote.id);
  state.policy.version = "demo-v2";
  fails(() => service.createRequest(DEMO_ALICE, { quoteId: quote.id, confirmationId: confirmation.id, idempotencyKey: "op" }), "QUOTE_STALE");
});

test("response-loss replay succeeds even after expiry without duplicate side effects", () => {
  const { service, state, advance } = setup();
  const quote = service.quote(DEMO_ALICE, "O-1001", mixed);
  const confirmation = service.confirmQuote(DEMO_ALICE, quote.id);
  const input = { quoteId: quote.id, confirmationId: confirmation.id, idempotencyKey: "stable" };
  const original = service.createRequest(DEMO_ALICE, input);
  advance(86_400_000);
  assert.deepEqual(service.createRequest(DEMO_ALICE, input), original);
  assert.equal(state.requests.size, 1);
  assert.equal(state.variants.get("SKU-TEE-L")?.stock, 1);
  assert.deepEqual(service.getOperation(DEMO_ALICE, "stable"), { status: "completed", request: original });
  assert.equal(service.getOperation(DEMO_BOB, "stable").status, "not_found");
  fails(() => service.getRequest(DEMO_BOB, original.id), "NOT_FOUND");
});

test("a key cannot be reused for changed parameters; new keys cannot resubmit a used quote", () => {
  const { service, state } = setup();
  const quote = service.quote(DEMO_ALICE, "O-1001", teeReturn);
  const confirmation = service.confirmQuote(DEMO_ALICE, quote.id);
  const input = { quoteId: quote.id, confirmationId: confirmation.id, idempotencyKey: "stable" };
  service.createRequest(DEMO_ALICE, input);
  fails(() => service.createRequest(DEMO_ALICE, { ...input, confirmationId: "changed" }), "IDEMPOTENCY_CONFLICT");
  fails(() => service.createRequest(DEMO_ALICE, { ...input, idempotencyKey: "different" }), "QUOTE_ALREADY_USED");
  assert.equal(state.requests.size, 1);
});

test("confirmation from a different quote cannot authorize an operation", () => {
  const { service } = setup();
  const one = service.quote(DEMO_ALICE, "O-1001", teeReturn);
  const two = service.quote(DEMO_ALICE, "O-1001", mixed);
  const confirmation = service.confirmQuote(DEMO_ALICE, one.id);
  fails(() => service.createRequest(DEMO_ALICE, { quoteId: two.id, confirmationId: confirmation.id, idempotencyKey: "op" }), "CONFIRMATION_MISMATCH");
});

test("two shoppers competing for the last item cannot oversell it", async () => {
  const { service, state } = setup();
  service.setStockForDemo("SKU-TEE-L", 1);
  const exchange = mixed.slice(0, 1);
  const alice = service.quote(DEMO_ALICE, "O-1001", exchange);
  const bob = service.quote(DEMO_BOB, "O-2001", exchange);
  const aliceConfirmation = service.confirmQuote(DEMO_ALICE, alice.id);
  const bobConfirmation = service.confirmQuote(DEMO_BOB, bob.id);
  const results = await Promise.allSettled([
    Promise.resolve().then(() => service.createRequest(DEMO_ALICE, { quoteId: alice.id, confirmationId: aliceConfirmation.id, idempotencyKey: "last" })),
    Promise.resolve().then(() => service.createRequest(DEMO_BOB, { quoteId: bob.id, confirmationId: bobConfirmation.id, idempotencyKey: "last" })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(state.variants.get("SKU-TEE-L")?.stock, 0);
  assert.equal(state.requests.size, 1);
});

test("mutating returned snapshots cannot change stored amounts or actions", () => {
  const { service } = setup();
  const quote = service.quote(DEMO_ALICE, "O-1001", teeReturn);
  quote.refundCents = 999999;
  quote.actions[0]!.quantity = 999;
  const confirmation = service.confirmQuote(DEMO_ALICE, quote.id);
  const request = service.createRequest(DEMO_ALICE, { quoteId: quote.id, confirmationId: confirmation.id, idempotencyKey: "op" });
  assert.equal(request.refundCents, 9900);
  assert.equal(request.actions[0]?.quantity, 1);
});
