import 'dotenv/config';
import { spawnSync } from 'node:child_process';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未配置，不能执行真实 PostgreSQL 测试');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/postgres.test.ts'], { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: process.env.DATABASE_URL } });
process.exitCode = result.status ?? 1;
