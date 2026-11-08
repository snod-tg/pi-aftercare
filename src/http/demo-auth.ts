import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError } from '../domain/errors.js';
import { DEMO_ALICE, DEMO_BOB } from '../domain/seed.js';
import type { Actor } from '../domain/types.js';

// Public tokens for the local simulator only; not a production authentication mechanism.
const actors = new Map<string, Actor>([
  ['Bearer demo-alice', DEMO_ALICE],
  ['Bearer demo-bob', DEMO_BOB],
]);

declare module 'fastify' {
  interface FastifyRequest {
    aftercareActor: Actor | null;
  }
}

export function protectDemoRoutes(app: FastifyInstance) {
  app.decorateRequest('aftercareActor', null);
  app.addHook('preHandler', async (request) => {
    const actor = actors.get(request.headers.authorization ?? '');
    if (!actor)
      throw new DomainError('UNAUTHORIZED', '本地演示需要使用 demo-alice 或 demo-bob 令牌', 401);
    request.aftercareActor = { ...actor };
  });
}

export function demoActor(request: FastifyRequest): Actor {
  if (!request.aftercareActor) throw new Error('受保护路由未安装演示身份校验');
  return request.aftercareActor;
}
