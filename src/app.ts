import Fastify from "fastify";
import { AftercareService } from "./domain/aftercare.js";
import type { AftercareBackend } from "./domain/backend.js";
import { DomainError } from "./domain/errors.js";
import { registerRoutes } from "./http/routes.js";

export function buildApp(options: { service?: AftercareBackend; logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof Error && "statusCode" in error && error.statusCode === 400) {
      return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "请求字段或参数格式不合法" } });
    }
    request.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "服务暂时无法处理此请求" } });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "pi-aftercare",
    version: "0.1.0",
  }));

  app.register(async (routes) => registerRoutes(routes, options.service ?? new AftercareService()));

  return app;
}
