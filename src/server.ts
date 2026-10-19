import { buildApp } from "./app.js";
import { config } from "./config.js";

import { createBusinessRuntime } from "./storage/runtime.js";

const runtime = await createBusinessRuntime();
const app = buildApp({ service: runtime.service, persistent: runtime.persistent });
app.addHook("onClose", () => runtime.close());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen(config);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
