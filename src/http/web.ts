import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from 'typebox';
import { AgentConversation, readRunLimits, type ConversationRestore, type TraceEvent } from '../agent/conversation.js';
import { readModelConnection } from '../agent/model-connection.js';
import type { AftercareBackend } from '../domain/backend.js';
import { DomainError } from '../domain/errors.js';
import type { Actor } from '../domain/types.js';
import { MemorySessionStore, type SavedSession, type SessionStore } from '../storage/sessions.js';
import { demoActor } from './demo-auth.js';
import type { PolicyEvidence, WebSnapshot } from './web-types.js';

export type ConversationFactory = (actor: Actor, restore: ConversationRestore) => Promise<AgentConversation>;
const params = Type.Object({ id: Type.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false });
const empty = Type.Object({}, { additionalProperties: false });
const messageBody = Type.Object({ content: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false });
const confirmBody = Type.Object({ quoteId: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false });

function recoverInterrupted(s: SavedSession) {
  if (!s.busy) return;
  s.busy = false;
  s.messages.push({ id: randomUUID(), role: 'assistant', time: new Date().toISOString(), status: 'interrupted',
    text: '上轮处理因服务中断而停止。已保存的对话和方案已恢复，请核对实际申请回执；如需继续，可以发送消息查询状态或确认当前仍有效的方案。' });
  delete s.lastRun;
  s.touched = Date.now();
}
function remember(s: SavedSession, event: TraceEvent) {
  if (event.type === 'text') return;
  s.trace.push({ time: event.time, type: event.type, tool: event.tool ?? '', ...(event.ok === undefined ? {} : { ok: event.ok }) });
  s.trace = s.trace.slice(-100);
  if (event.tool === 'search_aftercare_policy' && event.data && typeof event.data === 'object') {
    const data = event.data as { hits?: PolicyEvidence[]; retrievedAt?: string };
    for (const hit of data.hits ?? []) {
      if (typeof hit.citation !== 'string' || typeof hit.text !== 'string') continue;
      s.evidence = [...s.evidence.filter(e => e.citation !== hit.citation), {
        citation: hit.citation, title: hit.title, text: hit.text,
        policyVersion: hit.policyVersion, retrievedAt: data.retrievedAt ?? event.time,
      }].slice(-10);
    }
  }
}

export function registerWebRoutes(app: FastifyInstance, service: AftercareBackend, options: {
  conversationFactory?: ConversationFactory; persistent?: boolean; sessionStore?: SessionStore;
} = {}) {
  const store = options.sessionStore ?? new MemorySessionStore();
  const create: ConversationFactory = options.conversationFactory ?? ((actor, restore) => AgentConversation.create({
    service, actor, connection: readModelConnection(), limits: readRunLimits(), confirmationMode: 'web', ...restore,
  }));
  const active = new Map<string, { actor: Actor; controller: AbortController; done: Promise<void> }>();
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
    for (const run of active.values()) run.controller.abort();
    await Promise.all([...active.values()].map(run => run.done));
  });
  const snapshot = async (s: SavedSession): Promise<WebSnapshot> => {
    // Read actual business operations even if a process died just after committing a write.
    const requests = new Map(s.requests.map(request => [request.id, request]));
    const completed = new Set<string>();
    for (const receipt of s.checkpoint.receipts) {
      const operation = await service.getOperation(s.actor, receipt.idempotencyKey);
      if (operation.status === 'completed') { requests.set(operation.request.id, operation.request); completed.add(receipt.quoteId); }
    }
    const order = await service.getOrder(s.actor, s.actor.customerId === 'C-ALICE' ? 'O-1001' : 'O-2001');
    const quotes = await Promise.all(s.checkpoint.quotes.filter(quote => !completed.has(quote.id)).map(async quote => {
      const source = quote.orderId === order.id ? order : await service.getOrder(s.actor, quote.orderId);
      const descriptions = await Promise.all(quote.actions.map(async action => {
        const name = source.lines.find(item => item.id === action.lineId)?.name ?? action.lineId;
        if (action.kind === 'return') return `退货 · ${name} × ${action.quantity}`;
        const target = (await service.listVariants(s.actor, quote.orderId, action.lineId)).find(item => item.id === action.targetVariantId);
        return `换货 · ${name} → ${target?.size ?? action.targetVariantId} 码 × ${action.quantity}`;
      }));
      return { ...quote, descriptions };
    }));
    return { id: s.id, busy: s.busy, order, messages: s.messages, quotes, requests: [...requests.values()], evidence: s.evidence,
      trace: s.trace, ...(s.lastRun ? { lastRun: s.lastRun } : {}) };
  };
  const read = async (actor: Actor, id: string) => {
    let value = await store.load(actor, id);
    if (value.busy && !active.has(id)) {
      // A live worker holds the lock. Only a free lock proves the previous run ended.
      try {
        const lease = await store.acquire(actor, id);
        try { value = lease.value; recoverInterrupted(value); await lease.save(value); }
        finally { await lease.release(); }
      } catch (error) { if (!(error instanceof DomainError) || error.code !== 'SESSION_BUSY') throw error; }
    }
    return value;
  };
  const stream = async (actor: Actor, id: string, reply: FastifyReply, action: string, confirm: boolean) => {
    if (closing) throw new DomainError('SERVER_CLOSING', '服务正在重启，请稍后重试', 503);
    if (active.size >= 16) throw new DomainError('SESSION_CAPACITY', '同时处理的对话较多，请稍后重试', 429);
    const lease = await store.acquire(actor, id);
    const s = lease.value;
    recoverInterrupted(s);
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    active.set(id, { actor, controller, done });
    let conversation: AgentConversation | undefined;
    let started = false;
    const persist = async () => {
      if (conversation) s.checkpoint = conversation.exportCheckpoint();
      s.touched = Date.now();
      await lease.save(s);
    };
    const send = (event: string, data: unknown) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      if (s.messages.length >= 60) throw new DomainError('SESSION_LIMIT', '对话已较长，请开始新对话', 409);
      if (!confirm && !action.trim()) throw new DomainError('EMPTY_MESSAGE', '请输入消息', 400);
      conversation = await create(actor, { checkpoint: s.checkpoint, onCheckpoint: persist });
      controller.signal.addEventListener('abort', () => conversation?.cancel(), { once: true });
      if (confirm && !(await conversation.pendingQuotes()).some(q => q.id === action)) throw new DomainError('UNKNOWN_QUOTE', '方案已处理或不属于当前会话', 409);
      if (controller.signal.aborted) throw new DomainError('RUN_CANCELLED', '本轮已停止', 409);
      s.busy = true;
      s.messages.push({ id: randomUUID(), role: 'user', text: confirm ? '我已确认方案，请提交售后申请。' : action, time: new Date().toISOString() });
      await persist(); // Accept a turn only after the user action is durable.
      reply.hijack(); started = true;
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
      reply.raw.once('close', disconnect);
      heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 15_000);
      send('start', { busy: true });
      try {
        const onEvent = (event: TraceEvent) => { remember(s, event); send('trace', event); };
        const result = await (confirm ? conversation.confirmAndContinue(action, onEvent, controller.signal) : conversation.run(action, onEvent));
        s.messages.push({ id: randomUUID(), role: 'assistant', text: result.text || (result.status === 'completed' ? '本轮未生成文字回复，请查看方案和处理记录。' : '本轮处理未完成，请查看状态后重试。'), time: new Date().toISOString(), status: result.status });
        s.lastRun = { status: result.status, modelCalls: result.modelCalls, toolCalls: result.toolCalls, tokens: result.tokens };
        const receipts = new Map(s.requests.map(item => [item.id, item]));
        for (const operation of result.operations) if (operation.status === 'completed') receipts.set(operation.request.id, operation.request);
        s.requests = [...receipts.values()]; s.busy = false;
        await persist(); // No successful SSE result is announced before the checkpoint commits.
        send('result', await snapshot(s));
      } catch (error) {
        s.busy = false;
        const message = error instanceof DomainError ? error.message : '处理或会话保存中断，请刷新并核对实际申请状态';
        const cancelled = error instanceof DomainError && error.code === 'RUN_CANCELLED';
        if (cancelled) s.lastRun = { status: 'cancelled', modelCalls: 0, toolCalls: 0, tokens: 0 };
        s.messages.push({ id: randomUUID(), role: 'assistant', text: message, time: new Date().toISOString(), status: cancelled ? 'cancelled' : 'model_error' });
        try { await persist(); } catch { app.log.error('会话检查点保存失败；下一次读取将核对实际业务状态'); }
        send('error', { message });
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      reply.raw.off('close', disconnect);
      if (started && !reply.raw.writableEnded) reply.raw.end();
      try { await conversation?.close(); }
      finally { active.delete(id); try { await lease.release(); } finally { finish(); } }
    }
  };

  app.get('/api/meta', async () => ({ service: 'Pi Aftercare', demo: true, persistent: options.persistent ?? false,
    sessionPersistent: store.persistent, model: process.env.MODEL_NAME ?? '', configured: Boolean(process.env.MODEL_NAME && process.env.MODEL_BASE_URL) }));
  app.get('/api/sessions', async request => ({ sessions: await store.list(demoActor(request)) }));
  app.post('/api/sessions', { schema: { body: empty } }, async (request, reply) => {
    if (closing) throw new DomainError('SERVER_CLOSING', '服务正在重启，请稍后重试', 503);
    const actor = demoActor(request);
    const conversation = await create(actor, {});
    try {
      const session: SavedSession = { version: 1, id: randomUUID(), actor, busy: false, touched: Date.now(),
        checkpoint: conversation.exportCheckpoint(), messages: [], trace: [], evidence: [], requests: [] };
      const view = await snapshot(session); await store.create(session);
      return reply.code(201).send(view);
    } finally { await conversation.close(); }
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id', { schema: { params } }, async request => snapshot(await read(demoActor(request), request.params.id)));
  app.post<{ Params: { id: string }; Body: { content: string } }>('/api/sessions/:id/messages', { schema: { params, body: messageBody } }, async (request, reply) => stream(demoActor(request), request.params.id, reply, request.body.content, false));
  app.post<{ Params: { id: string }; Body: { quoteId: string } }>('/api/sessions/:id/confirm', { schema: { params, body: confirmBody } }, async (request, reply) => stream(demoActor(request), request.params.id, reply, request.body.quoteId, true));
  app.post<{ Params: { id: string } }>('/api/sessions/:id/cancel', { schema: { params, body: empty } }, async request => {
    const actor = demoActor(request); await store.load(actor, request.params.id);
    const run = active.get(request.params.id);
    if (run && run.actor.customerId === actor.customerId && run.actor.merchantId === actor.merchantId) run.controller.abort();
    else if ((await read(actor, request.params.id)).busy) throw new DomainError('REMOTE_SESSION_BUSY', '该会话正在另一服务实例处理，请等待该轮结束', 409);
    return { status: 'cancelling' };
  });
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', { schema: { params } }, async request => {
    const lease = await store.acquire(demoActor(request), request.params.id);
    try { await lease.remove(); return { status: 'closed' }; }
    finally { await lease.release(); }
  });
}
