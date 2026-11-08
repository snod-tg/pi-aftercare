import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type, type Static } from 'typebox';
import type { AftercareBackend } from '../domain/backend.js';
import type { Actor } from '../domain/types.js';
import type { SessionStore } from '../storage/sessions.js';
import { demoActor, protectDemoRoutes } from './demo-auth.js';
import { createEventStream } from './sse.js';
import { WebSessions, type ConversationFactory, type TurnCommand } from './session-service.js';
import type { ServiceMeta } from './web-types.js';

export type { ConversationFactory } from './session-service.js';

const params = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 80 }) },
  { additionalProperties: false },
);
const empty = Type.Object({}, { additionalProperties: false });
const messageBody = Type.Object(
  { content: Type.String({ minLength: 1, maxLength: 4000 }) },
  { additionalProperties: false },
);
const confirmBody = Type.Object(
  { quoteId: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);
type SessionParams = Static<typeof params>;

export function registerWebRoutes(
  app: FastifyInstance,
  service: AftercareBackend,
  options: {
    conversationFactory?: ConversationFactory;
    persistent?: boolean;
    sessionStore?: SessionStore;
  } = {},
) {
  const sessions = new WebSessions(service, {
    ...options,
    logError: (message) => app.log.error(message),
  });
  app.addHook('preClose', () => sessions.close());
  app.get(
    '/api/meta',
    async (): Promise<ServiceMeta> => ({
      service: 'Pi Aftercare',
      demo: true,
      persistent: options.persistent ?? false,
      sessionPersistent: sessions.persistent,
      model: process.env.MODEL_NAME ?? '',
      configured: Boolean(process.env.MODEL_NAME && process.env.MODEL_BASE_URL),
    }),
  );

  const streamTurn = async (
    actor: Actor,
    id: string,
    reply: FastifyReply,
    command: TurnCommand,
  ) => {
    const stream = createEventStream(reply);
    try {
      await sessions.runTurn(actor, id, command, stream);
    } finally {
      stream.close();
    }
  };

  app.register(async (routes) => {
    protectDemoRoutes(routes);
    routes.get('/api/sessions', async (request) => ({
      sessions: await sessions.list(demoActor(request)),
    }));
    routes.post('/api/sessions', { schema: { body: empty } }, async (request, reply) =>
      reply.code(201).send(await sessions.create(demoActor(request))),
    );
    routes.get<{ Params: SessionParams }>(
      '/api/sessions/:id',
      { schema: { params } },
      async (request) => sessions.snapshot(demoActor(request), request.params.id),
    );
    routes.post<{ Params: SessionParams; Body: Static<typeof messageBody> }>(
      '/api/sessions/:id/messages',
      { schema: { params, body: messageBody } },
      async (request, reply) =>
        streamTurn(demoActor(request), request.params.id, reply, {
          kind: 'message',
          content: request.body.content,
        }),
    );
    routes.post<{ Params: SessionParams; Body: Static<typeof confirmBody> }>(
      '/api/sessions/:id/confirm',
      { schema: { params, body: confirmBody } },
      async (request, reply) =>
        streamTurn(demoActor(request), request.params.id, reply, {
          kind: 'confirm',
          quoteId: request.body.quoteId,
        }),
    );
    routes.post<{ Params: SessionParams }>(
      '/api/sessions/:id/cancel',
      { schema: { params, body: empty } },
      async (request) => sessions.cancel(demoActor(request), request.params.id),
    );
    routes.delete<{ Params: SessionParams }>(
      '/api/sessions/:id',
      { schema: { params } },
      async (request) => sessions.remove(demoActor(request), request.params.id),
    );
  });
}
