// Test-only process: real PostgreSQL and Pi SDK, deterministic model HTTP transport.
import { buildApp } from '../../src/app.js';
import { createBusinessRuntime } from '../../src/storage/runtime.js';
import { AgentConversation } from '../../src/agent/conversation.js';
import { readModelConnection } from '../../src/agent/model-connection.js';
import { messageText, mockApi } from '../support/mock-api.js';
const runtime = await createBusinessRuntime({ DATABASE_URL: process.env.TEST_DATABASE_URL!, DATABASE_SCHEMA: process.env.TEST_SCHEMA! });
const connection = readModelConnection({ MODEL_BASE_URL: 'http://model.test/v1', MODEL_NAME: 'test-model' });
const app = buildApp({ service: runtime.service, sessionStore: runtime.sessionStore, persistent: true, logger: false,
  conversationFactory: (actor, restore) => {
    const api = mockApi(body => {
      const last = body.messages.at(-1)!;
      const text = messageText(last);
      if (last.role === 'user') {
        if (text.includes('应用已记录用户')) return { calls: [{ name: 'create_aftercare_request', args: JSON.parse(text.split('\n')[1]!) }] };
        if (text.includes('继续')) {
          const approval = body.messages.find(message => message.role === 'user' && messageText(message).includes('应用已记录用户'));
          if (!approval) throw new Error('恢复后模型上下文缺少原确认记录');
          const receipt = JSON.parse(messageText(approval).split('\n')[1]!);
          return { calls: [{ name: 'get_request_status', args: { idempotencyKey: receipt.idempotencyKey } }] };
        }
        return { calls: [{ name: 'search_aftercare_policy', args: { orderId: 'O-1001', query: '退货期限 退款 换货' } }] };
      }
      if (last.role === 'tool') {
        const data = JSON.parse(text);
        if (data.hits) return { calls: [{ name: 'quote_aftercare', args: { orderId: 'O-1001', actions: [
          { kind: 'return', lineId: 'LINE-JACKET', quantity: 1 },
          { kind: 'exchange', lineId: 'LINE-TEE', quantity: 1, targetVariantId: 'SKU-TEE-L' },
        ] } }] };
        if (data.id?.startsWith('Q-')) return { text: '外套退货199元，T恤换L码，请点击方案确认。' };
        if (data.id?.startsWith('R-') && process.env.TEST_HANG_AFTER_WRITE === '1') {
          process.send?.({ type: 'committed' }); return { waitForAbort: true };
        }
        return { text: '后台已有售后申请，等待寄回，退款尚未开始。' };
      }
      return { text: '请说明需求。' };
    });
    return AgentConversation.create({ ...restore, service: runtime.service, actor, connection, fetch: api.transport, confirmationMode: 'web' });
  },
});
app.addHook('onClose', () => runtime.close());
process.on('SIGTERM', () => { void app.close().then(() => process.disconnect?.()); });
const url = await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ type: 'ready', url });
