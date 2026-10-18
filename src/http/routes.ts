import { searchPolicy } from "../retrieval/policies.js";
import type { FastifyInstance } from "fastify";
import { Type, type Static } from "typebox";
import type { AftercareBackend } from "../domain/backend.js";
import { ConfirmSchema, CreateRequestSchema, IdSchema, LineLookupSchema, OrderIdSchema, QuoteInputSchema } from "../domain/schemas.js";
import { demoActor } from "./demo-auth.js";

export async function registerRoutes(app: FastifyInstance, service: AftercareBackend) {
  await app.register(async (routes) => {
    routes.addHook("preHandler", async (request) => { demoActor(request); });

    routes.get<{ Params: Static<typeof OrderIdSchema> }>("/orders/:orderId", {
      schema: { params: OrderIdSchema },
    }, async (request) => service.getOrder(demoActor(request), request.params.orderId));

    routes.get<{ Params: Static<typeof OrderIdSchema> }>("/orders/:orderId/policy", {
      schema: { params: OrderIdSchema },
    }, async (request) => service.getPolicy(demoActor(request), request.params.orderId));

    routes.get<{ Params: Static<typeof LineLookupSchema> }>("/orders/:orderId/lines/:lineId/variants", {
      schema: { params: LineLookupSchema },
    }, async (request) => service.listVariants(demoActor(request), request.params.orderId, request.params.lineId));

    routes.get<{ Params: Static<typeof OrderIdSchema>; Querystring: { query: string } }>("/orders/:orderId/policy/search", {
      schema: { params: OrderIdSchema, querystring: Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }) },
    }, async request => searchPolicy(service, demoActor(request), { orderId: request.params.orderId, query: request.query.query }));

    routes.post<{ Body: Static<typeof QuoteInputSchema> }>("/quotes", {
      schema: { body: QuoteInputSchema },
    }, async (request, reply) => {
      return reply.code(201).send(await service.quote(demoActor(request), request.body.orderId, request.body.actions));
    });

    const quoteParams = Type.Object({ quoteId: IdSchema }, { additionalProperties: false });
    routes.post<{ Params: Static<typeof quoteParams>; Body: Static<typeof ConfirmSchema> }>("/quotes/:quoteId/confirm", {
      schema: { params: quoteParams, body: ConfirmSchema },
    }, async (request, reply) => {
      return reply.code(201).send(await service.confirmQuote(demoActor(request), request.params.quoteId));
    });

    routes.post<{ Body: Static<typeof CreateRequestSchema> }>("/requests", {
      schema: { body: CreateRequestSchema },
    }, async (request) => service.createRequest(demoActor(request), request.body));

    const requestParams = Type.Object({ requestId: IdSchema }, { additionalProperties: false });
    routes.get<{ Params: Static<typeof requestParams> }>("/requests/:requestId", {
      schema: { params: requestParams },
    }, async (request) => service.getRequest(demoActor(request), request.params.requestId));

    const operationParams = Type.Object({ idempotencyKey: IdSchema }, { additionalProperties: false });
    routes.get<{ Params: Static<typeof operationParams> }>("/operations/:idempotencyKey", {
      schema: { params: operationParams },
    }, async (request) => service.getOperation(demoActor(request), request.params.idempotencyKey));
  });
}
