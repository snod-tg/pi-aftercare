import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

const auth = { authorization: "Bearer demo-alice" };
const payload = { orderId: "O-1001", actions: [{ kind: "return", lineId: "LINE-JACKET", quantity: 1 }] };

test("HTTP workflow enforces customer confirmation and preserves retry results", async () => {
  const app = buildApp({ logger: false });
  try {
    assert.equal((await app.inject({ url: "/orders/O-1001" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/orders/O-2001", headers: auth })).statusCode, 404);
    const quoteResponse = await app.inject({ method: "POST", url: "/quotes", headers: auth, payload });
    assert.equal(quoteResponse.statusCode, 201);
    const quoteId = quoteResponse.json().id as string;
    assert.equal((await app.inject({ method: "POST", url: `/quotes/${quoteId}/confirm`, headers: auth, payload: { confirmed: false } })).statusCode, 400);
    const confirmation = await app.inject({ method: "POST", url: `/quotes/${quoteId}/confirm`, headers: auth, payload: { confirmed: true } });
    assert.equal(confirmation.statusCode, 201);
    const request = { quoteId, confirmationId: confirmation.json().id as string, idempotencyKey: "http-demo" };
    const one = await app.inject({ method: "POST", url: "/requests", headers: auth, payload: request });
    const two = await app.inject({ method: "POST", url: "/requests", headers: auth, payload: request });
    assert.equal(one.statusCode, 200);
    assert.deepEqual(one.json(), two.json());
    assert.equal(one.json().refundCents, 19900);
    assert.equal(one.json().refundStatus, "not_started");
    const status = await app.inject({ url: "/operations/http-demo", headers: auth });
    assert.deepEqual(status.json().request, one.json());
    assert.equal((await app.inject({ url: `/requests/${one.json().id}`, headers: { authorization: "Bearer demo-bob" } })).statusCode, 404);
  } finally { await app.close(); }
});

test("schemas reject unknown amounts, identities, extra action fields and string quantities", async () => {
  const app = buildApp({ logger: false });
  try {
    for (const badPayload of [
      { ...payload, refundCents: 999999 },
      { ...payload, customerId: "C-BOB" },
      { ...payload, actions: [{ kind: "return", lineId: "LINE-JACKET", quantity: "1" }] },
      { ...payload, actions: [{ kind: "return", lineId: "LINE-JACKET", quantity: 1, targetVariantId: "SKU-TEE-L" }] },
    ]) {
      const response = await app.inject({ method: "POST", url: "/quotes", headers: auth, payload: badPayload });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, "INVALID_REQUEST");
    }
  } finally { await app.close(); }
});

test("domain conflict codes reach callers and invalid payloads do not expose internal errors", async () => {
  const app = buildApp({ logger: false });
  try {
    const unavailable = await app.inject({ method: "POST", url: "/quotes", headers: auth, payload: {
      orderId: "O-1001", actions: [{ kind: "exchange", lineId: "LINE-TEE", quantity: 1, targetVariantId: "SKU-TEE-XL" }],
    } });
    assert.equal(unavailable.statusCode, 409);
    assert.equal(unavailable.json().error.code, "OUT_OF_STOCK");
    const malformed = await app.inject({ method: "POST", url: "/quotes", headers: { ...auth, "content-type": "application/json" }, payload: "{" });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, "INVALID_REQUEST");
  } finally { await app.close(); }
});

test("HTTP rejects whitespace-only IDs after portable schema validation", async () => {
  const app = buildApp({ logger: false });
  try {
    for (const orderId of [" ", "\t\n", "\u3000", "\u00a0"]) {
      const response = await app.inject({ method: "POST", url: "/quotes", headers: auth, payload: { ...payload, orderId } });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, "INVALID_ID");
    }
    const response = await app.inject({ method: "POST", url: "/requests", headers: auth, payload: {
      quoteId: "Q-unknown", confirmationId: "CF-unknown", idempotencyKey: " \t\u3000",
    } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_ID");
  } finally { await app.close(); }
});
