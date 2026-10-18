import assert from "node:assert/strict";
import test from "node:test";
import { createConnectedModel, readModelConnection } from "../src/agent/model-connection.js";

test("model connection reads API settings without starting or discovering a model service", async () => {
  const config = readModelConnection({ MODEL_BASE_URL: "http://127.0.0.1:8080/v1/", MODEL_NAME: "aftercare-local", MODEL_API_KEY: "test-only" });
  assert.equal(config.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(config.contextWindow, 8192);
  const { modelRuntime, model } = await createConnectedModel(config);
  assert.equal(model.id, "aftercare-local");
  assert.equal(model.baseUrl, config.baseUrl);
  assert.equal(model.maxTokens, 1024);
  assert.equal(modelRuntime.getModel("aftercare-api", "missing"), undefined);
});

test("invalid model configuration fails before a network request", () => {
  assert.throws(() => readModelConnection({}), /MODEL_BASE_URL/);
  const base = { MODEL_BASE_URL: "http://127.0.0.1:8080/v1", MODEL_NAME: "example" };
  for (const MODEL_BASE_URL of ["file:///tmp/model", "http://user:secret@localhost/v1", "http://localhost/v1?key=secret", "invalid"]) {
    assert.throws(() => readModelConnection({ ...base, MODEL_BASE_URL }));
  }
  assert.throws(() => readModelConnection({ ...base, MODEL_MAX_OUTPUT_TOKENS: "8192" }), /上下文/);
  assert.throws(() => readModelConnection({ ...base, MODEL_CONTEXT_WINDOW: "-1" }), /正整数/);
});
