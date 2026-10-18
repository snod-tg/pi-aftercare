import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAftercareSession } from "../src/agent/session.js";
import { AftercareService } from "../src/domain/aftercare.js";
import { DEMO_ALICE } from "../src/domain/seed.js";

const modelRuntime = await ModelRuntime.create({
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new Error("Credential writes are disabled in the offline initialization check");
    },
    delete: async () => {},
  },
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
});

const { session } = await createAftercareSession({
  service: new AftercareService(),
  actor: DEMO_ALICE,
  modelRuntime,
});

try {
  assert.deepEqual(session.getActiveToolNames().sort(), [
    "get_order", "get_aftercare_policy", "list_variants", "quote_aftercare",
    "create_aftercare_request", "get_request_status",
  ].sort());
  assert.match(session.systemPrompt, /Pi Aftercare/);
  console.log("Pi session created with six business tools and no coding tools; no model API was called.");
} finally {
  session.dispose();
}
