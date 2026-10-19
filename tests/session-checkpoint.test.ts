import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentConversation } from '../src/agent/conversation.js';
import { readModelConnection } from '../src/agent/model-connection.js';
import { AftercareService } from '../src/domain/aftercare.js';
import { createDemoState, DEMO_ALICE, DEMO_BOB } from '../src/domain/seed.js';
import { messageText, mockApi } from './support/mock-api.js';
const connection = readModelConnection({ MODEL_BASE_URL: 'http://model.test/v1', MODEL_NAME: 'test-model' });

test('Pi checkpoint restores raw tool context and repairs an unresolved write as unknown without executing it', async () => {
  const state = createDemoState(); const service = new AftercareService(state);
  const api = mockApi((body, index) => {
    if (index === 0) return { calls: [{ name: 'quote_aftercare', args: { orderId: 'O-1001', actions: [{ kind: 'return', lineId: 'LINE-JACKET', quantity: 1 }] } }] };
    if (index === 1) return { text: '预计退款199元，请确认方案。' };
    if (index === 2) return { calls: [{ name: 'create_aftercare_request', args: JSON.parse(messageText(body.messages.at(-1)!).split('\n')[1]!) }] };
    return { text: '等待寄回。' };
  });
  const first = await AgentConversation.create({ service, actor: DEMO_ALICE, connection, fetch: api.transport });
  const quote = (await first.run('记住：外套退货')).pendingQuotes[0]!;
  const receipt = await first.confirm(quote.id);
  await first.confirmAndContinue(quote.id);
  const checkpoint = first.exportCheckpoint(); await first.close();
  const index = checkpoint.entries.findIndex(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'create_aftercare_request');
  assert.ok(index > 0); checkpoint.entries = checkpoint.entries.slice(0, index);
  const readback = mockApi((body, index) => {
    if (index === 0) {
      assert.match(JSON.stringify(body.messages), /记住：外套退货/);
      assert.match(JSON.stringify(body.messages), /INTERRUPTED_TOOL/);
      assert.ok(body.messages.some(message => message.role === 'tool' && messageText(message).includes('INTERRUPTED_TOOL')));
      return { calls: [{ name: 'get_request_status', args: { idempotencyKey: receipt.idempotencyKey } }] };
    }
    return { text: '已核对原申请，等待寄回。' };
  });
  const restored = await AgentConversation.create({ service, actor: DEMO_ALICE, connection, fetch: readback.transport, checkpoint });
  try {
    assert.equal((await restored.pendingQuotes()).length, 0);
    const result = await restored.run('继续，请先查询');
    assert.equal(result.operations[0]?.status, 'completed'); assert.equal(state.requests.size, 1);
    assert.equal(result.toolCalls, 1); assert.equal(result.trace.find(event => event.type === 'tool_start')?.tool, 'get_request_status');
    assert.equal(result.tokens, 120); // Restored historical usage is not charged to this turn.
    await assert.rejects(AgentConversation.create({ service, actor: DEMO_BOB, connection, checkpoint }), /归属不匹配/);
  } finally { await restored.close(); }
});

test('checkpoint redaction handles quoted API keys without corrupting serialized Pi messages', async () => {
  const secret = 'test-key-"quoted"';
  const api = mockApi(() => ({ text: `upstream echoed ${secret}` }));
  const conversation = await AgentConversation.create({ service: new AftercareService(), actor: DEMO_ALICE, connection: { ...connection, apiKey: secret }, fetch: api.transport });
  try {
    await conversation.run('你好');
    const checkpoint = conversation.exportCheckpoint();
    assert.ok(!JSON.stringify(checkpoint).includes('test-key-'));
    assert.match(JSON.stringify(checkpoint), /\[redacted\]/);
  } finally { await conversation.close(); }
});
