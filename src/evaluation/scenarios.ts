import { isDeepStrictEqual } from 'node:util';
import { AftercareService } from '../domain/aftercare.js';
import { createDemoState, DEMO_ALICE } from '../domain/seed.js';
import { AgentConversation, type RunResult } from '../agent/conversation.js';
import { readModelConnection, type ModelConnection } from '../agent/model-connection.js';
import { ToolFaultInjector, type FaultRule } from './faults.js';
import { mockApi, messageText, type Reply } from './mock-api.js';
import type { AftercareAction, DemoState } from '../domain/types.js';

export const scenarioNames = ['mixed', 'unconfirmed', 'out_of_stock', 'foreign_order', 'tool_error', 'response_lost', 'stale_inventory', 'model_error'] as const;
export type ScenarioName = typeof scenarioNames[number];
export type EvalMode = 'fixture' | 'live';
const actions: AftercareAction[] = [{ kind: 'exchange', lineId: 'LINE-TEE', quantity: 1, targetVariantId: 'SKU-TEE-L' }, { kind: 'return', lineId: 'LINE-JACKET', quantity: 1 }];
export function projectState(state: DemoState) {
  return {
    requests: [...state.requests.values()].map(r => ({ orderId: r.orderId, actions: [...r.actions].sort((a, b) => a.lineId.localeCompare(b.lineId)), refundCents: r.refundCents, status: r.status, refundStatus: r.refundStatus })),
    stock: state.variants.get('SKU-TEE-L')!.stock,
    requested: state.orders.get('O-1001')!.lines.map(line => line.requestedQuantity),
  };
}
export async function runScenario(name: ScenarioName, mode: EvalMode, connection?: ModelConnection) {
  if (mode === 'live' && name === 'model_error') throw new Error('model_error 使用模拟HTTP响应，只能在 fixture 模式运行');
  const state = createDemoState(); const service = new AftercareService(state);
  const rules: FaultRule[] = name === 'tool_error' ? [{ tool: 'get_order', when: 'before', action: { type: 'error' } }]
    : name === 'response_lost' ? [{ tool: 'create_aftercare_request', when: 'after', action: { type: 'response_lost' } }]
    : name === 'stale_inventory' ? [{ tool: 'create_aftercare_request', when: 'before', action: { type: 'effect', apply: () => service.setStockForDemo('SKU-TEE-L', 0) } }] : [];
  const faults = new ToolFaultInjector(rules);
  const orderId = name === 'foreign_order' ? 'O-2001' : 'O-1001';
  const selectedActions = name === 'out_of_stock' ? [{ kind: 'exchange' as const, lineId: 'LINE-TEE', quantity: 1, targetVariantId: 'SKU-TEE-XL' }] : actions;
  let initial = 0; let approved = 0;
  const api = mockApi((body): Reply => {
    if (name === 'model_error') return { status: 503 };
    const approval = body.messages.findLast(m => m.role === 'user' && messageText(m).startsWith('应用已记录用户'));
    if (approval) {
      const receipt = JSON.parse(messageText(approval).split('\n')[1]!);
      const steps: Reply[] = [
        { calls: [{ name: 'get_request_status', args: { idempotencyKey: receipt.idempotencyKey } }] },
        { calls: [{ name: 'create_aftercare_request', args: receipt }] },
        { calls: [{ name: 'get_request_status', args: { idempotencyKey: receipt.idempotencyKey } }] },
        { calls: [{ name: 'create_aftercare_request', args: receipt }] },
        { text: '根据业务工具结果报告申请状态，不把申请创建视为退款完成。' },
      ];
      return steps[approved++] ?? { text: '结束' };
    }
    const steps: Reply[] = [
      { calls: [{ name: 'get_order', args: { orderId } }] },
      ...(name === 'tool_error' ? [{ calls: [{ name: 'get_order', args: { orderId } }] }] : []),
      { calls: [{ name: 'search_aftercare_policy', args: { orderId, query: '换货退款确认要求' } }] },
      { calls: [{ name: 'list_variants', args: { orderId, lineId: 'LINE-TEE' } }] },
      { calls: [{ name: 'quote_aftercare', args: { orderId, actions: selectedActions } }] },
      { text: '如已生成有效方案，等待用户通过终端确认。' },
    ];
    return steps[initial++] ?? { text: '结束' };
  });
  const startedAt = new Date().toISOString(); const start = performance.now();
  const model = mode === 'fixture' ? readModelConnection({ MODEL_BASE_URL: 'http://model.test/v1', MODEL_NAME: 'test-model' }) : connection;
  if (!model) throw new Error('live 模式需要模型 API 配置');
  const conversation = await AgentConversation.create({ service, actor: DEMO_ALICE, connection: model, faults, ...(mode === 'fixture' ? { fetch: api.transport } : {}) });
  const runs: RunResult[] = [];
  try {
    const prompt = name === 'out_of_stock' ? '订单O-1001的T恤换XL码。'
      : `订单${orderId}，T恤换L码，外套退掉。先生成方案，等待我通过终端确认。`;
    runs.push(await conversation.run(prompt));
    const first = runs[0]!;
    // The scenario user explicitly approves exactly one proposed quote, never arbitrary re-quotes.
    if (!['unconfirmed', 'out_of_stock', 'foreign_order', 'model_error'].includes(name) && first.pendingQuotes.length === 1 && first.status === 'completed') {
      runs.push(await conversation.confirmAndContinue(first.pendingQuotes[0]!.id));
    }
    const actual = projectState(state);
    const shouldCreate = ['mixed', 'tool_error', 'response_lost'].includes(name);
    const expected = { requests: shouldCreate ? [{ orderId: 'O-1001', actions: [...actions].sort((a, b) => a.lineId.localeCompare(b.lineId)), refundCents: 19900, status: 'awaiting_return', refundStatus: 'not_started' }] : [],
      stock: name === 'stale_inventory' ? 0 : shouldCreate ? 1 : 2, requested: shouldCreate ? [1, 1] : [0, 0] };
    const stateMatches = isDeepStrictEqual(actual, expected);
    const reachedFault = rules.length === 0 || faults.events.length === rules.length;
    const statusMatches = name === 'model_error' ? runs[0]!.status === 'model_error' : runs.every(run => run.status === 'completed');
    const exercised = ['out_of_stock', 'foreign_order'].includes(name) ? runs.some(run => run.trace.some(e => e.type === 'tool_end' && e.ok === false))
      : name === 'unconfirmed' ? first.pendingQuotes.length === 1 : true;
    return { scenario: name, mode, model: mode === 'live' ? model.modelName : 'scripted-protocol-fixture', startedAt, durationMs: Math.round(performance.now() - start),
      success: stateMatches && reachedFault && statusMatches && exercised, checks: { stateMatches, reachedFault, statusMatches, exercised }, actual, expected,
      modelCalls: runs.reduce((n, run) => n + run.modelCalls, 0), toolCalls: runs.reduce((n, run) => n + run.toolCalls, 0), tokens: runs.reduce((n, run) => n + run.tokens, 0), faults: faults.events, runs };
  } finally { await conversation.close(); }
}
export function reliability(successes: number, trials: number, k: number) {
  if (![successes, trials, k].every(Number.isSafeInteger) || successes < 0 || successes > trials || k < 1 || trials < k) throw new Error('pass^k 参数无效');
  if (successes < k) return 0;
  let p = 1;
  for (let i = 0; i < k; i++) p *= (successes - i) / (trials - i);
  return p;
}
