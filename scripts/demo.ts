import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

const app = buildApp({ logger: false });
const headers = { authorization: "Bearer demo-alice" };
try {
  const order = await app.inject({ url: "/orders/O-1001", headers });
  assert.equal(order.statusCode, 200);
  console.log("1. 客户请求：T 恤换 L 码，外套退掉。已查询订单 O-1001。");
  const quoteResponse = await app.inject({ method: "POST", url: "/quotes", headers, payload: {
    orderId: "O-1001",
    actions: [
      { kind: "exchange", lineId: "LINE-TEE", quantity: 1, targetVariantId: "SKU-TEE-L" },
      { kind: "return", lineId: "LINE-JACKET", quantity: 1 },
    ],
  } });
  assert.equal(quoteResponse.statusCode, 201);
  const quote = quoteResponse.json();
  console.log(`2. 后端报价：退货金额 ¥${(quote.refundCents / 100).toFixed(2)}，政策 ${quote.policyVersion}，等待客户确认。`);
  // This HTTP action represents an explicit customer click; no Agent confirmation tool exists.
  const confirmation = await app.inject({ method: "POST", url: `/quotes/${quote.id}/confirm`, headers, payload: { confirmed: true } });
  assert.equal(confirmation.statusCode, 201);
  console.log("3. 客户通过独立确认接口确认具体方案。");
  const payload = { quoteId: quote.id, confirmationId: confirmation.json().id, idempotencyKey: "demo-mixed-return-exchange" };
  const first = await app.inject({ method: "POST", url: "/requests", headers, payload });
  assert.equal(first.statusCode, 200);
  console.log("4. 创建申请；模拟响应丢失，先按原业务操作键查询，再复用原键重试。");
  const recovered = await app.inject({ url: `/operations/${payload.idempotencyKey}`, headers });
  const retry = await app.inject({ method: "POST", url: "/requests", headers, payload });
  assert.equal(recovered.json().request.id, first.json().id);
  assert.equal(retry.json().id, first.json().id);
  console.log("5. 恢复到同一份售后申请，未重复创建。回执：");
  console.log(JSON.stringify({ id: retry.json().id, status: retry.json().status, refundStatus: retry.json().refundStatus, refundCents: retry.json().refundCents }, null, 2));
  console.log("说明：这是确定性业务演示，没有调用模型；申请等待寄回，退款尚未开始。");
} finally { await app.close(); }
