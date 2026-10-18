import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PostgresAftercareService } from '../src/storage/postgres.js';
import { createDemoState, DEMO_ALICE, DEMO_BOB } from '../src/domain/seed.js';
import type { AftercareAction } from '../src/domain/types.js';
import { AgentConversation } from '../src/agent/conversation.js';
import { readModelConnection } from '../src/agent/model-connection.js';
import { mockApi } from './support/mock-api.js';
const url = process.env.TEST_DATABASE_URL;
const mixed: AftercareAction[] = [{ kind: 'exchange', lineId: 'LINE-TEE', quantity: 1, targetVariantId: 'SKU-TEE-L' }, { kind: 'return', lineId: 'LINE-JACKET', quantity: 1 }];

test('real PostgreSQL: durable restart, atomic rollback, concurrent inventory and idempotency', { skip: !url }, async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let rollback = false;
  const a = new PostgresAftercareService({ connectionString: url!, schema, beforeCommit: () => { if (rollback) throw new Error('injected pre-commit failure'); } });
  const b = new PostgresAftercareService({ connectionString: url!, schema });
  try {
    await a.migrate();
    const seed = createDemoState(); seed.variants.get('SKU-TEE-L')!.stock = 1;
    await a.seed(seed); await b.seed();
    const qa = await a.quote(DEMO_ALICE, 'O-1001', mixed);
    const qb = await b.quote(DEMO_BOB, 'O-2001', mixed);
    const ca = await a.confirmQuote(DEMO_ALICE, qa.id);
    assert.deepEqual(await b.confirmQuote(DEMO_ALICE, qa.id), ca);
    const cb = await b.confirmQuote(DEMO_BOB, qb.id);
    const input = { quoteId: qa.id, confirmationId: ca.id, idempotencyKey: ca.idempotencyKey };
    rollback = true;
    await assert.rejects(a.createRequest(DEMO_ALICE, input), /pre-commit/);
    rollback = false;
    assert.equal((await b.getOperation(DEMO_ALICE, input.idempotencyKey)).status, 'not_found');
    assert.equal((await b.getOrder(DEMO_ALICE, 'O-1001')).version, 1);
    assert.equal((await b.listVariants(DEMO_ALICE, 'O-1001', 'LINE-TEE')).find(v => v.id === 'SKU-TEE-L')!.stock, 1);
    const results = await Promise.allSettled([
      a.createRequest(DEMO_ALICE, input),
      b.createRequest(DEMO_BOB, { quoteId: qb.id, confirmationId: cb.id, idempotencyKey: cb.idempotencyKey }),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    assert.equal((await a.listVariants(DEMO_ALICE, 'O-1001', 'LINE-TEE')).find(v => v.id === 'SKU-TEE-L')!.stock, 0);
    const winner = results[0]!.status === 'fulfilled' ? { actor: DEMO_ALICE, input } : { actor: DEMO_BOB, input: { quoteId: qb.id, confirmationId: cb.id, idempotencyKey: cb.idempotencyKey } };
    const original = await a.createRequest(winner.actor, winner.input);
    const replays = await Promise.all(Array.from({ length: 6 }, () => b.createRequest(winner.actor, winner.input)));
    assert.ok(replays.every(r => r.id === original.id));
    await assert.rejects(b.createRequest(winner.actor, { ...winner.input, confirmationId: 'changed' }), /相同幂等键/);
    const reopened = new PostgresAftercareService({ connectionString: url!, schema, now: () => new Date(Date.now() + 86400000) });
    try {
      assert.deepEqual(await reopened.createRequest(winner.actor, winner.input), original);
      assert.deepEqual((await reopened.getOperation(winner.actor, winner.input.idempotencyKey)), { status: 'completed', request: original });
      await assert.rejects(reopened.getOrder({ ...DEMO_ALICE, merchantId: 'other' }, 'O-1001'));
    } finally { await reopened.close(); }
    const counts = await a.pool.query(`SELECT count(*)::int AS count FROM "${schema}".resources WHERE kind='request'`);
    assert.equal(counts.rows[0].count, 1);
  } finally {
    await a.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await Promise.all([a.close(), b.close()]);
  }
});

test('real PostgreSQL: pending quote and stable approval survive a new Agent session', { skip: !url }, async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const service = new PostgresAftercareService({ connectionString: url!, schema });
  try {
    await service.migrate(); await service.seed();
    const quote = await service.quote(DEMO_ALICE, 'O-1001', mixed);
    const receipt = await service.confirmQuote(DEMO_ALICE, quote.id);
    const api = mockApi(() => ({ text: '等待继续处理' }));
    const conversation = await AgentConversation.create({ service, actor: DEMO_ALICE, connection: readModelConnection({ MODEL_BASE_URL: 'http://model.test/v1', MODEL_NAME: 'test-model' }), restorePendingQuotes: true, fetch: api.transport });
    try {
      assert.equal((await conversation.pendingQuotes())[0]!.id, quote.id);
      assert.deepEqual(await conversation.confirm(quote.id), { quoteId: quote.id, confirmationId: receipt.id, idempotencyKey: receipt.idempotencyKey });
    } finally { await conversation.close(); }
  } finally { await service.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await service.close(); }
});
