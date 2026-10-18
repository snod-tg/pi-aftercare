import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolFaultInjector } from '../src/evaluation/faults.js';
import { AgentConversation } from '../src/agent/conversation.js';
import { readModelConnection } from '../src/agent/model-connection.js';
import { AftercareService } from '../src/domain/aftercare.js';
import { createDemoState, DEMO_ALICE } from '../src/domain/seed.js';
import { mockApi, messageText } from './support/mock-api.js';
const connection = readModelConnection({ MODEL_BASE_URL: 'http://model.test/v1', MODEL_NAME: 'test-model' });
const actions = [{ kind: 'exchange', lineId: 'LINE-TEE', quantity: 1, targetVariantId: 'SKU-TEE-L' }];

test('tool faults are one-shot and recovery is decided by the model protocol', async () => {
  const faults = new ToolFaultInjector([{ tool: 'get_order', when: 'before', action: { type: 'error' } }]);
  const api = mockApi((_body, i) => i < 2 ? { calls: [{ name: 'get_order', args: { orderId: 'O-1001' } }] } : { text: '查询已恢复' });
  const conversation = await AgentConversation.create({ service: new AftercareService(), actor: DEMO_ALICE, connection, faults, fetch: api.transport });
  try {
    const result = await conversation.run('查订单');
    assert.equal(result.status, 'completed'); assert.equal(faults.events.length, 1);
    assert.match(JSON.stringify(api.requests[1]!.messages), /INJECTED_TOOL_ERROR/);
    assert.ok(result.trace.some(e => e.type === 'tool_end' && e.ok === true));
  } finally { await conversation.close(); }
});

test('response lost after a committed create is recovered with status and the same operation key', async () => {
  const state = createDemoState(); const service = new AftercareService(state);
  const faults = new ToolFaultInjector([{ tool: 'create_aftercare_request', when: 'after', action: { type: 'response_lost' } }]);
  let receipt: Record<string, string>;
  const api = mockApi((body, i) => {
    if (i === 0) return { calls: [{ name: 'quote_aftercare', args: { orderId: 'O-1001', actions } }] };
    if (i === 1) return { text: '等待确认' };
    if (i === 2) {
      receipt = JSON.parse(messageText(body.messages.at(-1)!).split('\n')[1]!);
      return { calls: [{ name: 'create_aftercare_request', args: receipt }] };
    }
    if (i === 3) { assert.match(JSON.stringify(body.messages), /RESPONSE_LOST/); return { calls: [{ name: 'get_request_status', args: { idempotencyKey: receipt.idempotencyKey } }] }; }
    if (i === 4) return { calls: [{ name: 'create_aftercare_request', args: receipt }] };
    return { text: '已恢复原申请，等待寄回' };
  });
  const conversation = await AgentConversation.create({ service, actor: DEMO_ALICE, connection, faults, fetch: api.transport });
  try {
    const quote = (await conversation.run('换L码')).pendingQuotes[0]!;
    const result = await conversation.confirmAndContinue(quote.id);
    assert.equal(result.status, 'completed'); assert.equal(result.operations[0]!.status, 'completed');
    assert.equal(state.requests.size, 1); assert.equal(state.variants.get('SKU-TEE-L')!.stock, 1);
    assert.equal(faults.events.length, 1);
  } finally { await conversation.close(); }
});

test('inventory mutation after confirmation invalidates a quote instead of creating an application', async () => {
  const state = createDemoState(); const service = new AftercareService(state);
  const faults = new ToolFaultInjector([{ tool: 'create_aftercare_request', when: 'before', action: { type: 'effect', apply: () => service.setStockForDemo('SKU-TEE-L', 0) } }]);
  const api = mockApi((body, i) => {
    if (i === 0) return { calls: [{ name: 'quote_aftercare', args: { orderId: 'O-1001', actions } }] };
    if (i === 1) return { text: '请确认' };
    if (i === 2) return { calls: [{ name: 'create_aftercare_request', args: JSON.parse(messageText(body.messages.at(-1)!).split('\n')[1]!) }] };
    assert.match(JSON.stringify(body.messages), /QUOTE_STALE/);
    return { text: '库存已变化，原方案不能提交，需重新选择并确认。' };
  });
  const conversation = await AgentConversation.create({ service, actor: DEMO_ALICE, connection, faults, fetch: api.transport });
  try {
    const first = await conversation.run('换L码'); const second = await conversation.confirmAndContinue(first.pendingQuotes[0]!.id);
    assert.equal(state.requests.size, 0); assert.equal(second.operations[0]!.status, 'not_found');
  } finally { await conversation.close(); }
});

test('delay before a write cannot execute it after the run has timed out', async () => {
  const state = createDemoState();
  const faults = new ToolFaultInjector([{ tool: 'quote_aftercare', when: 'before', action: { type: 'delay', ms: 60 } }]);
  const api = mockApi(() => ({ calls: [{ name: 'quote_aftercare', args: { orderId: 'O-1001', actions } }] }));
  const conversation = await AgentConversation.create({ service: new AftercareService(state), actor: DEMO_ALICE, connection, faults, fetch: api.transport, limits: { timeoutMs: 20, maxModelCalls: 4, maxToolCalls: 4 } });
  try {
    assert.equal((await conversation.run('换L码')).status, 'timeout');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(state.quotes.size, 0); assert.equal(state.requests.size, 0);
  } finally { await conversation.close(); }
});
