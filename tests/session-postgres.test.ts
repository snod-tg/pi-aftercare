import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { PostgresAftercareService } from '../src/storage/postgres.js';
import { PostgresSessionStore } from '../src/storage/sessions.js';
import { DEMO_ALICE, DEMO_BOB } from '../src/domain/seed.js';
import type { WebSnapshot, SessionSummary } from '../src/http/web-types.js';
const url = process.env.TEST_DATABASE_URL;
const headers = { authorization: 'Bearer demo-alice', 'content-type': 'application/json' };
function parseResult(body: string): WebSnapshot {
  const packet = body.split('\n\n').find(packet => packet.startsWith('event: result\n'));
  assert.ok(packet, body); return JSON.parse(packet.split('\ndata: ')[1]!) as WebSnapshot;
}
async function boot(schema: string, hang = false) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/session-server.ts'], {
    env: { ...process.env, TEST_DATABASE_URL: url!, TEST_SCHEMA: schema, TEST_HANG_AFTER_WRITE: hang ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr!.on('data', (data: Buffer) => { output += data.toString(); });
  const address = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`测试服务启动超时: ${output}`)); }, 15000);
    child.on('message', message => { const data = message as { type: string; url?: string }; if (data.type === 'ready') { clearTimeout(timer); resolve(data.url!); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}: ${output}`)); });
  });
  return { child, address };
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(signal); await exited;
}

test('real PostgreSQL: sessions survive two process restarts and SIGKILL after a committed write without replay', { skip: !url, timeout: 60000 }, async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const business = new PostgresAftercareService({ connectionString: url!, schema });
  const children: ChildProcess[] = [];
  try {
    await business.migrate(); await business.seed();
    const one = await boot(schema); children.push(one.child);
    const created = await fetch(`${one.address}/api/sessions`, { method: 'POST', headers, body: '{}' });
    assert.equal(created.status, 201); const id = (await created.json() as WebSnapshot).id;
    const initial = parseResult(await (await fetch(`${one.address}/api/sessions/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ content: '订单O-1001，外套退掉，T恤换L码' }) })).text());
    const quoteId = initial.quotes[0]!.id;
    assert.ok(initial.evidence.length > 0); assert.ok(initial.trace.length > 0);
    await stop(one.child);

    const two = await boot(schema, true); children.push(two.child);
    const restored = await (await fetch(`${two.address}/api/sessions/${id}`, { headers })).json() as WebSnapshot;
    assert.deepEqual(restored.messages, initial.messages); assert.deepEqual(restored.evidence, initial.evidence);
    assert.deepEqual(restored.trace, initial.trace); assert.equal(restored.quotes[0]!.id, quoteId);
    assert.equal(restored.busy, false);
    const history = await (await fetch(`${two.address}/api/sessions`, { headers })).json() as { sessions: SessionSummary[] };
    assert.equal(history.sessions[0]?.id, id);
    assert.equal((await fetch(`${two.address}/api/sessions/${id}`, { headers: { authorization: 'Bearer demo-bob' } })).status, 404);
    const store = new PostgresSessionStore(business.pool, schema); await store.initialize();
    await assert.rejects(store.load(DEMO_BOB, id), /不属于/);
    const lock = await store.acquire(DEMO_ALICE, id);
    try { await assert.rejects(store.acquire(DEMO_ALICE, id), /仍在处理/); }
    finally { await lock.release(); }

    const committed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待创建申请超时')), 15000);
      two.child.on('message', message => { if ((message as { type: string }).type === 'committed') { clearTimeout(timer); resolve(); } });
    });
    const submission = fetch(`${two.address}/api/sessions/${id}/confirm`, { method: 'POST', headers, body: JSON.stringify({ quoteId }) }).then(response => response.text()).catch(() => 'connection interrupted');
    await committed;
    // This is an actual process crash: no preClose hook or final snapshot can run.
    await stop(two.child, 'SIGKILL'); await submission;
    const interrupted = await store.load(DEMO_ALICE, id);
    assert.equal(interrupted.busy, true);
    assert.equal(interrupted.checkpoint.receipts.length, 1);
    assert.ok(interrupted.checkpoint.entries.some(entry => entry.type === 'message' && entry.message.role === 'toolResult'));

    const three = await boot(schema); children.push(three.child);
    const recovered = await (await fetch(`${three.address}/api/sessions/${id}`, { headers })).json() as WebSnapshot;
    assert.equal(recovered.busy, false); assert.equal(recovered.quotes.length, 0);
    assert.equal(recovered.requests.length, 1); assert.equal(recovered.requests[0]?.refundStatus, 'not_started');
    assert.equal(recovered.messages.at(-1)?.status, 'interrupted');
    const receiptId = recovered.requests[0]!.id;
    const continued = parseResult(await (await fetch(`${three.address}/api/sessions/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ content: '继续，先查询原申请状态，不要重新创建' }) })).text());
    assert.equal(continued.lastRun?.status, 'completed');
    assert.equal(continued.requests[0]!.id, receiptId);
    assert.ok(continued.trace.some(trace => trace.tool === 'get_request_status' && trace.ok));
    const count = await business.pool.query(`SELECT count(*)::int AS count FROM "${schema}".resources WHERE kind='request'`);
    assert.equal(count.rows[0].count, 1);
    const stored = await store.load(DEMO_ALICE, id);
    assert.equal(stored.busy, false);
    assert.equal(stored.checkpoint.receipts[0]!.idempotencyKey, interrupted.checkpoint.receipts[0]!.idempotencyKey);
    assert.equal((await fetch(`${three.address}/api/sessions/${id}/confirm`, { method: 'POST', headers, body: JSON.stringify({ quoteId }) })).status, 409);
  } finally {
    await Promise.all(children.map(child => stop(child, 'SIGKILL')));
    await business.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await business.close();
  }
});
