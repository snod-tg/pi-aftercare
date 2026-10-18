import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createAftercareTools } from "../src/agent/tools.js";
import { AftercareService } from "../src/domain/aftercare.js";
import { DEMO_ALICE } from "../src/domain/seed.js";

test("tools bind identity in the host and never expose a confirmation tool", async () => {
  const tools = createAftercareTools(new AftercareService(), DEMO_ALICE);
  assert.equal(tools.length, 7);
  assert.ok(!tools.some((tool) => /confirm/.test(tool.name)));
  const orderTool = tools.find((tool) => tool.name === "get_order")!;
  assert.equal(Check(orderTool.parameters, { orderId: "O-1001", customerId: "C-BOB" }), false);
  const context = {} as ExtensionToolContext;
  const result = await orderTool.execute("test", { orderId: "O-1001" }, undefined, undefined, context);
  const text = result.content[0];
  assert.ok(text?.type === "text");
  assert.equal(JSON.parse(text.text).customerId, "C-ALICE");
  await assert.rejects(orderTool.execute("test", { orderId: "O-2001" }, undefined, undefined, context), /NOT_FOUND/);
});

test("tool errors provide a recoverable domain code instead of returning success text", async () => {
  const tool = createAftercareTools(new AftercareService(), DEMO_ALICE).find((item) => item.name === "quote_aftercare")!;
  await assert.rejects(tool.execute("test", {
    orderId: "O-1001", actions: [{ kind: "exchange", lineId: "LINE-TEE", quantity: 1, targetVariantId: "SKU-TEE-XL" }],
  }, undefined, undefined, {} as ExtensionToolContext), /OUT_OF_STOCK/);
});
