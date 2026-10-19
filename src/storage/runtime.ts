import { AftercareService } from '../domain/aftercare.js';
import { PostgresAftercareService } from './postgres.js';
import pg from 'pg';
import { MemorySessionStore, PostgresSessionStore } from './sessions.js';
export async function createBusinessRuntime(env: NodeJS.ProcessEnv = process.env) {
  if (!env.DATABASE_URL) return { service: new AftercareService(), sessionStore: new MemorySessionStore(), persistent: false, close: async () => {} };
  const service = new PostgresAftercareService({ connectionString: env.DATABASE_URL, ...(env.DATABASE_SCHEMA ? { schema: env.DATABASE_SCHEMA } : {}) });
  // Session locks must not occupy the business pool while awaiting model responses.
  const sessionPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 20, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  sessionPool.on('error', () => {});
  const sessionStore = new PostgresSessionStore(sessionPool, service.schema);
  try { await sessionStore.initialize(); }
  catch (error) { await Promise.all([service.close(), sessionPool.end()]); throw error; }
  return { service, sessionStore, persistent: true, close: async () => { await Promise.all([service.close(), sessionPool.end()]); } };
}
