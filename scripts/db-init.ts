import 'dotenv/config';
import { PostgresAftercareService } from '../src/storage/postgres.js';
import { PostgresSessionStore } from '../src/storage/sessions.js';
if (!process.env.DATABASE_URL) throw new Error('请先配置 DATABASE_URL');
const service = new PostgresAftercareService({ connectionString: process.env.DATABASE_URL, ...(process.env.DATABASE_SCHEMA ? { schema: process.env.DATABASE_SCHEMA } : {}) });
try { await service.migrate(); await new PostgresSessionStore(service.pool, service.schema).initialize(); await service.seed(); console.log('业务表、会话表迁移与演示数据初始化完成；已有业务记录未重置。'); }
finally { await service.close(); }
