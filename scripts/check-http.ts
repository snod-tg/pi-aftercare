import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

const app = buildApp();
try {
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "pi-aftercare",
    version: "0.1.0",
  });
  console.log("Health endpoint check passed.");
} finally {
  await app.close();
}
