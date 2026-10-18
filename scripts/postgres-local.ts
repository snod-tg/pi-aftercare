import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import pg from 'pg';
const root = resolve('.');
const data = join(root, '.data');
const cluster = join(data, 'postgres');
const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const port = Number(process.env.PG_LOCAL_PORT ?? '55432');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PG_LOCAL_PORT 必须在 1024–65535');
const command = process.argv[2] ?? 'status';
const exec = (name: string, args: string[]) => execFileSync(join(bin, name), args, { stdio: 'inherit' });
mkdirSync(data, { recursive: true, mode: 0o700 });
if (command === 'start') {
  const passwordPath = join(data, 'postgres-password');
  if (!existsSync(join(cluster, 'PG_VERSION'))) {
    writeFileSync(passwordPath, randomBytes(24).toString('hex'), { mode: 0o600 });
    exec('initdb', ['-D', cluster, '-U', 'aftercare', '-A', 'scram-sha-256', '--pwfile', passwordPath, '--encoding=UTF8', '--locale=C']);
  }
  let running = false;
  try { execFileSync(join(bin, 'pg_ctl'), ['-D', cluster, 'status'], { stdio: 'ignore' }); running = true; } catch {}
  if (!running) exec('pg_ctl', ['-D', cluster, '-l', join(data, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start']);
  const password = readFileSync(passwordPath, 'utf8').trim();
  const url = new URL(`postgresql://aftercare@127.0.0.1:${port}/postgres`);
  url.password = password;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='pi_aftercare'")).rowCount) await client.query('CREATE DATABASE pi_aftercare');
  } finally { await client.end(); }
  url.pathname = '/pi_aftercare';
  const path = join(root, '.env');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : readFileSync(join(root, '.env.example'), 'utf8');
  // Do not overwrite an existing user's database connection.
  if (!/^DATABASE_URL=.+/m.test(current)) writeFileSync(path, current.replace(/\n?$/, '\n') + `DATABASE_URL=${url.toString()}\n`, { mode: 0o600 });
  console.log(`PostgreSQL ready on 127.0.0.1:${port}; project data: ${cluster}. Existing DATABASE_URL is preserved.`);
} else if (command === 'stop') exec('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop']);
else if (command === 'status') exec('pg_ctl', ['-D', cluster, 'status']);
else throw new Error('用法：postgres-local.ts start|stop|status');
