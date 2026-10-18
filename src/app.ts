import Fastify from "fastify";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({
    status: "ok",
    service: "pi-aftercare",
    version: "0.1.0",
  }));

  return app;
}
