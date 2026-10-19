import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import { AgentConversation, readRunLimits, type RunResult, type TraceEvent } from '../agent/conversation.js';
import { readModelConnection } from '../agent/model-connection.js';
import type { AftercareBackend } from '../domain/backend.js';
import { DomainError } from '../domain/errors.js';
import type { Actor, AftercareRequest } from '../domain/types.js';
import { demoActor } from './demo-auth.js';
import type { ChatMessage, PolicyEvidence, ToolTrace, WebSnapshot } from './web-types.js';

export type ConversationFactory = (actor: Actor) => Promise<AgentConversation>;
interface WebSession {
  id: string; actor: Actor; conversation: AgentConversation; busy: boolean; touched: number;
  messages: ChatMessage[]; trace: ToolTrace[]; evidence: PolicyEvidence[];
  requests: AftercareRequest[]; lastRun?: WebSnapshot['lastRun'];
  controller?: AbortController;
}
const params = Type.Object({ id: Type.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false });
const empty = Type.Object({}, { additionalProperties: false });
const messageBody = Type.Object({ content: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false });
const confirmBody = Type.Object({ quoteId: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false });
const ttl = 45 * 60_000;

export function registerWebRoutes(app: FastifyInstance, service: AftercareBackend, options: {
  conversationFactory?: ConversationFactory; persistent?: boolean;
} = {}) {
  const sessions = new Map<string, WebSession>();
  const create = options.conversationFactory ?? ((actor: Actor) => AgentConversation.create({
    service, actor, connection: readModelConnection(), limits: readRunLimits(), confirmationMode: 'web',
  }));
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (!session.busy && Date.now() - session.touched > ttl) {
      sessions.delete(id); void session.conversation.close();
    }
  }, 60_000);
  cleanup.unref();
  app.addHook('preClose', async () => {
    clearInterval(cleanup);
    await Promise.all([...sessions.values()].map(s => s.conversation.close()));
    sessions.clear();
  });
  const get = (request: FastifyRequest<{ Params: { id: string } }>) => {
    const actor = demoActor(request);
    const session = sessions.get(request.params.id);
    if (!session || session.actor.customerId !== actor.customerId || session.actor.merchantId !== actor.merchantId) {
      throw new DomainError('SESSION_NOT_FOUND', '会话已结束，请开始新的对话', 404);
    }
    session.touched = Date.now();
    return session;
  };
  const snapshot = async (s: WebSession): Promise<WebSnapshot> => {
    const order = await service.getOrder(s.actor, s.actor.customerId === 'C-ALICE' ? 'O-1001' : 'O-2001');
    const quotes = await Promise.all((await s.conversation.pendingQuotes()).map(async quote => {
      const source = quote.orderId === order.id ? order : await service.getOrder(s.actor, quote.orderId);
      const descriptions = await Promise.all(quote.actions.map(async action => {
        const line = source.lines.find(item => item.id === action.lineId);
        const name = line?.name ?? action.lineId;
        if (action.kind === 'return') return `退货 · ${name} × ${action.quantity}`;
        const variants = await service.listVariants(s.actor, quote.orderId, action.lineId);
        const target = variants.find(item => item.id === action.targetVariantId);
        return `换货 · ${name} → ${target?.size ?? action.targetVariantId} 码 × ${action.quantity}`;
      }));
      return { ...quote, descriptions };
    }));
    return { id: s.id, busy: s.busy, order, messages: s.messages, quotes,
      requests: s.requests, evidence: s.evidence, trace: s.trace,
      ...(s.lastRun ? { lastRun: s.lastRun } : {}) };
  };
  const remember = (s: WebSession, event: TraceEvent) => {
    if (event.type === 'text') return;
    s.trace.push({ time: event.time, type: event.type, tool: event.tool ?? '', ...(event.ok === undefined ? {} : { ok: event.ok }) });
    s.trace = s.trace.slice(-100);
    if (event.tool === 'search_aftercare_policy' && event.data && typeof event.data === 'object') {
      const data = event.data as { hits?: PolicyEvidence[]; retrievedAt?: string };
      for (const hit of data.hits ?? []) {
        if (typeof hit.citation !== 'string' || typeof hit.text !== 'string') continue;
        const evidence = { citation: hit.citation, title: hit.title, text: hit.text,
          policyVersion: hit.policyVersion, retrievedAt: data.retrievedAt ?? event.time };
        s.evidence = [...s.evidence.filter(e => e.citation !== hit.citation), evidence].slice(-10);
      }
    }
  };
  const stream = async (s: WebSession, reply: FastifyReply, action: string, confirm: boolean) => {
    if (s.busy) throw new DomainError('SESSION_BUSY', '上一轮仍在处理，请等待或停止后再试', 409);
    if (s.messages.length >= 60) throw new DomainError('SESSION_LIMIT', '对话已较长，请开始新对话', 409);
    s.busy = true; // Claim before the first await, including confirmation validation.
    const controller = new AbortController();
    s.controller = controller;
    controller.signal.addEventListener('abort', () => s.conversation.cancel(), { once: true });
    let started = false;
    try {
      if (confirm && !(await s.conversation.pendingQuotes()).some(q => q.id === action)) {
        throw new DomainError('UNKNOWN_QUOTE', '方案已处理或不属于当前会话', 409);
      }
      if (!confirm && !action.trim()) throw new DomainError('EMPTY_MESSAGE', '请输入消息', 400);
      if (controller.signal.aborted) throw new DomainError('RUN_CANCELLED', '本轮已停止', 409);
      s.messages.push({ id: randomUUID(), role: 'user', text: confirm ? '我已确认方案，请提交售后申请。' : action, time: new Date().toISOString() });
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
      started = true;
      const send = (event: string, data: unknown) => { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.once('close', disconnect);
      const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 15_000);
      try {
        send('start', { busy: true });
        const onEvent = (event: TraceEvent) => { remember(s, event); send('trace', event); };
        const result: RunResult = await (confirm ? s.conversation.confirmAndContinue(action, onEvent, controller.signal) : s.conversation.run(action, onEvent));
        s.messages.push({ id: randomUUID(), role: 'assistant', text: result.text || (result.status === 'completed' ? '本轮未生成文字回复，请查看方案和处理记录。' : '本轮处理未完成，请查看状态后重试。'), time: new Date().toISOString(), status: result.status });
        s.lastRun = { status: result.status, modelCalls: result.modelCalls, toolCalls: result.toolCalls, tokens: result.tokens };
        const receipts = new Map(s.requests.map(item => [item.id, item]));
        for (const operation of result.operations) if (operation.status === 'completed') receipts.set(operation.request.id, operation.request);
        s.requests = [...receipts.values()];
        s.busy = false;
        send('result', await snapshot(s));
      } catch (error) {
        s.busy = false;
        const message = error instanceof DomainError ? error.message : '处理暂时中断，请刷新状态后重试';
        const cancelled = error instanceof DomainError && error.code === 'RUN_CANCELLED';
        if (cancelled) s.lastRun = { status: 'cancelled', modelCalls: 0, toolCalls: 0, tokens: 0 };
        s.messages.push({ id: randomUUID(), role: 'assistant', text: message, time: new Date().toISOString(), status: cancelled ? 'cancelled' : 'model_error' });
        send('error', { message });
      } finally {
        clearInterval(heartbeat); reply.raw.off('close', disconnect); reply.raw.end();
      }
    } finally { s.busy = false; delete s.controller; s.touched = Date.now(); if (started && !reply.raw.writableEnded) reply.raw.end(); }
  };

  app.get('/api/meta', async () => ({ service: 'Pi Aftercare', demo: true, persistent: options.persistent ?? false,
    model: process.env.MODEL_NAME ?? '', configured: Boolean(process.env.MODEL_NAME && process.env.MODEL_BASE_URL) }));
  app.post('/api/sessions', { schema: { body: empty } }, async (request, reply) => {
    const actor = demoActor(request);
    // Check both sides of asynchronous SDK construction to cap resident sessions.
    if (sessions.size >= 32) throw new DomainError('SESSION_CAPACITY', '演示会话已满，请稍后再试', 429);
    const id = randomUUID();
    const conversation = await create(actor);
    if (sessions.size >= 32) { await conversation.close(); throw new DomainError('SESSION_CAPACITY', '演示会话已满', 429); }
    const session: WebSession = { id, actor, conversation, busy: false, touched: Date.now(), messages: [], trace: [], evidence: [], requests: [] };
    sessions.set(id, session);
    try { return reply.code(201).send(await snapshot(session)); }
    catch (error) { sessions.delete(id); await conversation.close(); throw error; }
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id', { schema: { params } }, async request => snapshot(get(request)));
  app.post<{ Params: { id: string }; Body: { content: string } }>('/api/sessions/:id/messages', { schema: { params, body: messageBody } }, async (request, reply) => stream(get(request), reply, request.body.content, false));
  app.post<{ Params: { id: string }; Body: { quoteId: string } }>('/api/sessions/:id/confirm', { schema: { params, body: confirmBody } }, async (request, reply) => stream(get(request), reply, request.body.quoteId, true));
  app.post<{ Params: { id: string } }>('/api/sessions/:id/cancel', { schema: { params, body: empty } }, async request => {
    const s = get(request); s.controller?.abort(); s.conversation.cancel(); return { status: 'cancelling' };
  });
  app.delete<{ Params: { id: string } }>('/api/sessions/:id', { schema: { params } }, async request => {
    const s = get(request);
    if (s.busy) throw new DomainError('SESSION_BUSY', '请先停止当前处理', 409);
    sessions.delete(s.id); await s.conversation.close(); return { status: 'closed' };
  });
}
