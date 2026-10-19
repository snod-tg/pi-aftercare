import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { MemorySessionStore } from '../src/storage/sessions.js';
import { AgentConversation } from '../src/agent/conversation.js';
import { readModelConnection } from '../src/agent/model-connection.js';
import { AftercareService } from '../src/domain/aftercare.js';
import { createDemoState } from '../src/domain/seed.js';
import type { WebSnapshot } from '../src/http/web-types.js';
import { messageText, mockApi } from './support/mock-api.js';
const auth = { authorization: 'Bearer demo-alice' };
const connection = readModelConnection({ MODEL_BASE_URL: 'http://model.test/v1', MODEL_NAME: 'test-model' });
function result(body: string): WebSnapshot {
  const packet = body.split('\n\n').find(packet => packet.startsWith('event: result\n'));
  assert.ok(packet, body);
  return JSON.parse(packet.split('\ndata: ')[1]!) as WebSnapshot;
}

test('web SSE uses real Pi tools, returns policy evidence and requires the confirmation button before writing', async () => {
  const state = createDemoState(); const service = new AftercareService(state);
  const transport = mockApi((body, index) => {
    assert.match(messageText(body.messages[0]!), /点击方案卡片/);
    assert.doesNotMatch(messageText(body.messages[0]!), /当前终端的确认方式/);
    if (index === 0) return { calls: [{ name: 'search_aftercare_policy', args: { orderId: 'O-1001', query: '退货期限 退款 换货' } }] };
    if (index === 1) return { calls: [{ name: 'quote_aftercare', args: { orderId: 'O-1001', actions: [
      { kind: 'return', lineId: 'LINE-JACKET', quantity: 1 },
      { kind: 'exchange', lineId: 'LINE-TEE', quantity: 1, targetVariantId: 'SKU-TEE-L' },
    ] } }] };
    if (index === 2) return { text: '外套退款199元，T恤换L码，请点击方案卡片确认。' };
    if (index === 3) {
      const approval = JSON.parse(messageText(body.messages.at(-1)!).split('\n')[1]!);
      return { calls: [{ name: 'create_aftercare_request', args: approval }] };
    }
    return { text: '申请已创建，等待寄回，退款尚未开始。' };
  });
  const app = buildApp({ logger: false, service, conversationFactory: (actor, restore) => AgentConversation.create({ ...restore, service, actor, connection, fetch: transport.transport, confirmationMode: 'web' }) });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/sessions', payload: {} })).statusCode, 401);
    const created = await app.inject({ method: 'POST', url: '/api/sessions', headers: auth, payload: {} });
    assert.equal(created.statusCode, 201); assert.equal(transport.requests.length, 0);
    const id = created.json().id as string;
    assert.equal((await app.inject({ url: `/api/sessions/${id}`, headers: { authorization: 'Bearer demo-bob' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, headers: auth, payload: { content: 'a', customerId: 'C-BOB' } })).statusCode, 400);
    const first = await app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, headers: auth, payload: { content: '外套退掉，T恤换L' } });
    assert.equal(first.statusCode, 200); assert.match(first.headers['content-type']!, /text\/event-stream/);
    const snapshot = result(first.body);
    assert.equal(state.requests.size, 0); assert.equal(snapshot.quotes[0]?.refundCents, 19900);
    assert.ok(snapshot.quotes[0]?.descriptions.some(text => text.includes('L 码')));
    assert.ok(snapshot.evidence.length > 0);
    assert.ok(snapshot.evidence[0]?.policyVersion); assert.ok(snapshot.evidence[0]?.retrievedAt);
    assert.ok(snapshot.trace.some(trace => trace.tool === 'search_aftercare_policy' && trace.ok));
    const quoteId = snapshot.quotes[0]!.id;
    assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, headers: auth, payload: { quoteId, confirmationId: 'forged' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, headers: auth, payload: { quoteId: 'forged' } })).statusCode, 409);
    const second = result((await app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, headers: auth, payload: { quoteId } })).body);
    assert.equal(state.requests.size, 1); assert.equal(second.quotes.length, 0);
    assert.equal(second.requests[0]?.refundStatus, 'not_started'); assert.equal(second.requests[0]?.status, 'awaiting_return');
    assert.equal(second.order.lines.find(line => line.id === 'LINE-JACKET')?.requestedQuantity, 1);
    assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, headers: auth, payload: { quoteId } })).statusCode, 409);
    assert.equal(state.requests.size, 1);
    const restored = (await app.inject({ url: `/api/sessions/${id}`, headers: auth })).json() as WebSnapshot;
    assert.equal(restored.messages.length, 4); assert.equal(restored.requests[0]?.id, second.requests[0]?.id);
    await app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, headers: auth });
    assert.equal((await app.inject({ url: `/api/sessions/${id}`, headers: auth })).statusCode, 404);
  } finally { await app.close(); }
});

test('web rejects overlapping turns, cancels the active model request and leaves the session usable', async () => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const api = mockApi((_body, index) => {
    if (index === 0) { started(); return { waitForAbort: true }; }
    return { text: '已恢复，可以继续。' };
  });
  const service = new AftercareService();
  const app = buildApp({ logger: false, service, conversationFactory: (actor, restore) => AgentConversation.create({ ...restore, service, actor, connection, fetch: api.transport, confirmationMode: 'web' }) });
  try {
    const id = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth, payload: {} })).json().id;
    const turn = app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, headers: auth, payload: { content: '查询订单' } });
    // Light-my-request starts a promise injection when then() is consumed.
    const completion = Promise.resolve(turn);
    await running;
    assert.equal((await app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, headers: auth, payload: { content: '重复消息' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, headers: auth })).statusCode, 409);
    await app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel`, headers: auth, payload: {} });
    const stopped = result((await completion).body);
    assert.equal(stopped.lastRun?.status, 'cancelled'); assert.equal(stopped.busy, false);
    const next = result((await app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, headers: auth, payload: { content: '继续' } })).body);
    assert.equal(next.lastRun?.status, 'completed'); assert.match(next.messages.at(-1)!.text, /已恢复/);
  } finally { await app.close(); }
});

test('cancellation during a slow confirmation cannot start model execution or create an application afterwards', async () => {
  const state = createDemoState(); const service = new AftercareService(state);
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const confirming = new Promise<void>(resolve => { entered = resolve; });
  const backend = Object.create(service) as typeof service;
  let confirmations = 0;
  Object.defineProperty(backend, 'confirmQuote', { value: async (...args: Parameters<typeof service.confirmQuote>) => {
    confirmations++; entered(); await gate; return service.confirmQuote(...args);
  } });
  const api = mockApi((body, index) => {
    if (index === 0) return { calls: [{ name: 'quote_aftercare', args: { orderId: 'O-1001', actions: [{ kind: 'return', lineId: 'LINE-JACKET', quantity: 1 }] } }] };
    if (index === 1) return { text: '请确认方案。' };
    if (index === 2) return { calls: [{ name: 'create_aftercare_request', args: JSON.parse(messageText(body.messages.at(-1)!).split('\n')[1]!) }] };
    return { text: '申请已创建，等待寄回。' };
  });
  const app = buildApp({ logger: false, service: backend, conversationFactory: (actor, restore) => AgentConversation.create({ ...restore, service: backend, actor, connection, fetch: api.transport, confirmationMode: 'web' }) });
  try {
    const id = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth, payload: {} })).json().id;
    const initial = result((await app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, headers: auth, payload: { content: '退外套' } })).body);
    const quoteId = initial.quotes[0]!.id;
    const pending = Promise.resolve(app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, headers: auth, payload: { quoteId } }));
    await confirming;
    await app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel`, headers: auth, payload: {} });
    release();
    assert.match((await pending).body, /本轮已停止/);
    assert.equal(state.requests.size, 0); assert.equal(api.requests.length, 2);
    const recovered = result((await app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, headers: auth, payload: { quoteId } })).body);
    assert.equal(confirmations, 1); assert.equal(recovered.requests.length, 1); assert.equal(state.requests.size, 1);
  } finally { release(); await app.close(); }
});

test('a checkpoint failure after approval blocks submission; recovery reuses the same business approval', async () => {
  const state = createDemoState(); const service = new AftercareService(state);
  let rejectApproved = false;
  class FailingStore extends MemorySessionStore {
    override async acquire(...args: Parameters<MemorySessionStore['acquire']>) {
      const lease = await super.acquire(...args);
      return { ...lease, save: async (next: typeof lease.value) => {
        if (rejectApproved && next.checkpoint.receipts.length) throw new Error('test persistence failure');
        await lease.save(next);
      } };
    }
  }
  const api = mockApi((body, index) => {
    if (index === 0) return { calls: [{ name: 'quote_aftercare', args: { orderId: 'O-1001', actions: [{ kind: 'return', lineId: 'LINE-JACKET', quantity: 1 }] } }] };
    if (index === 1) return { text: '请确认方案。' };
    if (index === 2) return { calls: [{ name: 'create_aftercare_request', args: JSON.parse(messageText(body.messages.at(-1)!).split('\n')[1]!) }] };
    return { text: '申请已创建，等待寄回。' };
  });
  const app = buildApp({ logger: false, service, sessionStore: new FailingStore(), conversationFactory: (actor, restore) => AgentConversation.create({ ...restore, service, actor, connection, fetch: api.transport, confirmationMode: 'web' }) });
  try {
    const id = (await app.inject({ method: 'POST', url: '/api/sessions', headers: auth, payload: {} })).json().id;
    const initial = result((await app.inject({ method: 'POST', url: `/api/sessions/${id}/messages`, headers: auth, payload: { content: '退外套' } })).body);
    const quoteId = initial.quotes[0]!.id;
    rejectApproved = true;
    const failure = await app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, headers: auth, payload: { quoteId } });
    assert.match(failure.body, /event: error/); assert.equal(state.requests.size, 0); assert.equal(api.requests.length, 2);
    const original = [...state.confirmations.values()][0]!; assert.ok(original);
    rejectApproved = false;
    const recovered = (await app.inject({ url: `/api/sessions/${id}`, headers: auth })).json() as WebSnapshot;
    assert.equal(recovered.busy, false); assert.equal(recovered.messages.at(-1)?.status, 'interrupted');
    const completed = result((await app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, headers: auth, payload: { quoteId } })).body);
    assert.equal(completed.requests.length, 1); assert.equal(state.confirmations.size, 1);
    assert.equal(completed.requests[0]?.idempotencyKey, original.idempotencyKey);
  } finally { await app.close(); }
});
