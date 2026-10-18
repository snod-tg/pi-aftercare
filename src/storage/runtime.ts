import { AftercareService } from '../domain/aftercare.js';
import { PostgresAftercareService } from './postgres.js';
export async function createBusinessRuntime(env: NodeJS.ProcessEnv = process.env) {
  if (!env.DATABASE_URL) return { service: new AftercareService(), persistent: false, close: async () => {} };
  const service = new PostgresAftercareService({ connectionString: env.DATABASE_URL, ...(env.DATABASE_SCHEMA ? { schema: env.DATABASE_SCHEMA } : {}) });
  return { service, persistent: true, close: () => service.close() };
}
