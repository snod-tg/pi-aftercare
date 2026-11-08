import { randomUUID } from 'node:crypto';
import {
  AgentConversation,
  readRunLimits,
  type ConversationRestore,
  type RunResult,
  type TraceEvent,
} from '../agent/conversation.js';
import { readModelConnection } from '../agent/model-connection.js';
import type { AftercareBackend } from '../domain/backend.js';
import { DomainError } from '../domain/errors.js';
import type { Actor } from '../domain/types.js';
import {
  MemorySessionStore,
  type SavedSession,
  type SessionLease,
  type SessionStore,
} from '../storage/sessions.js';
import { buildSessionSnapshot } from './session-snapshot.js';
import type { ChatMessage, PolicyEvidence, TurnCommand, WebTurnEvent } from './web-types.js';

export type ConversationFactory = (
  actor: Actor,
  restore: ConversationRestore,
) => Promise<AgentConversation>;
export interface TurnEvents {
  open(onDisconnect: () => void): void;
  send(event: WebTurnEvent): void;
}

interface ActiveTurn {
  actor: Actor;
  controller: AbortController;
  done: Promise<void>;
}

interface SessionServiceOptions {
  conversationFactory?: ConversationFactory;
  sessionStore?: SessionStore;
  logError(message: string): void;
}

const MAX_ACTIVE_TURNS = 16;
const MAX_SESSION_MESSAGES = 60;

function recoverInterrupted(s: SavedSession) {
  if (!s.busy) return;
  s.busy = false;
  s.messages.push({
    id: randomUUID(),
    role: 'assistant',
    time: new Date().toISOString(),
    status: 'interrupted',
    text: '上轮处理因服务中断而停止。已保存的对话和方案已恢复，请核对实际申请回执；如需继续，可以发送消息查询状态或确认当前仍有效的方案。',
  });
  delete s.lastRun;
  s.touched = Date.now();
}
function remember(s: SavedSession, event: TraceEvent) {
  if (event.type === 'text') return;
  if (event.type === 'tool_end' && event.ok && event.orderId) s.currentOrderId = event.orderId;
  s.trace.push({
    time: event.time,
    type: event.type,
    tool: event.tool ?? '',
    ...(event.ok === undefined ? {} : { ok: event.ok }),
  });
  s.trace = s.trace.slice(-100);
  if (event.tool === 'search_aftercare_policy' && event.data && typeof event.data === 'object') {
    const data = event.data as { hits?: PolicyEvidence[]; retrievedAt?: string };
    for (const hit of data.hits ?? []) {
      if (typeof hit.citation !== 'string' || typeof hit.text !== 'string') continue;
      s.evidence = [
        ...s.evidence.filter((e) => e.citation !== hit.citation),
        {
          citation: hit.citation,
          title: hit.title,
          text: hit.text,
          policyVersion: hit.policyVersion,
          retrievedAt: data.retrievedAt ?? event.time,
        },
      ].slice(-10);
    }
  }
}

function recordResult(session: SavedSession, result: RunResult) {
  session.messages.push({
    id: randomUUID(),
    role: 'assistant',
    text:
      result.text ||
      (result.status === 'completed'
        ? '本轮未生成文字回复，请查看方案和处理记录。'
        : '本轮处理未完成，请查看状态后重试。'),
    time: new Date().toISOString(),
    status: result.status,
  });
  session.lastRun = {
    status: result.status,
    modelCalls: result.modelCalls,
    toolCalls: result.toolCalls,
    tokens: result.tokens,
  };
  const requests = new Map(session.requests.map((item) => [item.id, item]));
  for (const operation of result.operations)
    if (operation.status === 'completed') requests.set(operation.request.id, operation.request);
  session.requests = [...requests.values()];
  session.busy = false;
}

function recordTurnFailure(session: SavedSession, error: unknown) {
  const message =
    error instanceof DomainError ? error.message : '处理或会话保存中断，请刷新并核对实际申请状态';
  const cancelled = error instanceof DomainError && error.code === 'RUN_CANCELLED';
  session.busy = false;
  if (cancelled) session.lastRun = { status: 'cancelled', modelCalls: 0, toolCalls: 0, tokens: 0 };
  session.messages.push({
    id: randomUUID(),
    role: 'assistant',
    text: message,
    time: new Date().toISOString(),
    status: cancelled ? 'cancelled' : 'model_error',
  });
  return message;
}

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new DomainError('RUN_CANCELLED', '本轮已停止', 409);
}

export class WebSessions {
  private readonly store: SessionStore;
  private readonly createConversation: ConversationFactory;
  private readonly active = new Map<string, ActiveTurn>();
  private closing = false;

  constructor(
    private readonly service: AftercareBackend,
    private readonly options: SessionServiceOptions,
  ) {
    this.store = options.sessionStore ?? new MemorySessionStore();
    this.createConversation =
      options.conversationFactory ??
      ((actor, restore) =>
        AgentConversation.create({
          service,
          actor,
          connection: readModelConnection(),
          limits: readRunLimits(),
          confirmationMode: 'web',
          ...restore,
        }));
  }

  get persistent() {
    return this.store.persistent;
  }

  private ensureOpen() {
    if (this.closing) throw new DomainError('SERVER_CLOSING', '服务正在重启，请稍后重试', 503);
  }

  async close() {
    this.closing = true;
    const active = [...this.active.values()];
    for (const turn of active) turn.controller.abort();
    await Promise.all(active.map((turn) => turn.done));
  }

  list(actor: Actor) {
    return this.store.list(actor);
  }

  async create(actor: Actor) {
    this.ensureOpen();
    const conversation = await this.createConversation(actor, {});
    try {
      const session: SavedSession = {
        version: 1,
        id: randomUUID(),
        actor,
        busy: false,
        touched: Date.now(),
        checkpoint: conversation.exportCheckpoint(),
        messages: [],
        trace: [],
        evidence: [],
        requests: [],
      };
      const snapshot = await buildSessionSnapshot(this.service, session);
      await this.store.create(session);
      return snapshot;
    } finally {
      await conversation.close();
    }
  }

  async snapshot(actor: Actor, id: string) {
    return buildSessionSnapshot(this.service, await this.read(actor, id));
  }

  private async read(actor: Actor, id: string) {
    const saved = await this.store.load(actor, id);
    if (!saved.busy || this.active.has(id)) return saved;
    // Only a free lock proves a previous worker ended.
    try {
      const lease = await this.store.acquire(actor, id);
      try {
        recoverInterrupted(lease.value);
        await lease.save(lease.value);
        return lease.value;
      } finally {
        await lease.release();
      }
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'SESSION_BUSY') throw error;
      return saved;
    }
  }

  async cancel(actor: Actor, id: string) {
    const saved = await this.store.load(actor, id);
    const active = this.active.get(id);
    if (
      active &&
      active.actor.customerId === actor.customerId &&
      active.actor.merchantId === actor.merchantId
    ) {
      active.controller.abort();
    } else if (saved.busy && (await this.read(actor, id)).busy) {
      throw new DomainError(
        'REMOTE_SESSION_BUSY',
        '该会话正在另一服务实例处理，请等待该轮结束',
        409,
      );
    }
    return { status: 'cancelling' as const };
  }

  async remove(actor: Actor, id: string) {
    const lease = await this.store.acquire(actor, id);
    try {
      await lease.remove();
      return { status: 'closed' as const };
    } finally {
      await lease.release();
    }
  }

  async runTurn(actor: Actor, id: string, command: TurnCommand, events: TurnEvents) {
    this.ensureOpen();
    if (this.active.size >= MAX_ACTIVE_TURNS)
      throw new DomainError('SESSION_CAPACITY', '同时处理的对话较多，请稍后重试', 429);
    if (this.active.has(id)) {
      // Check ownership before exposing a session's busy status.
      await this.store.load(actor, id);
      throw new DomainError('SESSION_BUSY', '上一轮仍在处理，请等待或停止后再试', 409);
    }
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // Reserve before awaiting the lease so concurrent requests cannot exceed capacity.
    this.active.set(id, { actor, controller, done });
    try {
      const lease = await this.store.acquire(actor, id);
      try {
        await this.executeTurn(lease, command, events, controller);
      } finally {
        await lease.release();
      }
    } finally {
      this.active.delete(id);
      finish();
    }
  }

  private async executeTurn(
    lease: SessionLease,
    command: TurnCommand,
    events: TurnEvents,
    controller: AbortController,
  ) {
    const session = lease.value;
    recoverInterrupted(session);
    if (session.messages.length >= MAX_SESSION_MESSAGES)
      throw new DomainError('SESSION_LIMIT', '对话已较长，请开始新对话', 409);
    if (command.kind === 'message' && !command.content.trim())
      throw new DomainError('EMPTY_MESSAGE', '请输入消息', 400);
    checkCancelled(controller.signal);

    let conversation: AgentConversation | undefined;
    const persist = async () => {
      if (conversation) session.checkpoint = conversation.exportCheckpoint();
      session.touched = Date.now();
      await lease.save(session);
    };
    const cancel = () => conversation?.cancel();
    try {
      conversation = await this.createConversation(session.actor, {
        checkpoint: session.checkpoint,
        onCheckpoint: persist,
      });
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (command.kind === 'confirm') {
        const quote = (await conversation.pendingQuotes()).find(
          (item) => item.id === command.quoteId,
        );
        if (!quote) throw new DomainError('UNKNOWN_QUOTE', '方案已处理或不属于当前会话', 409);
        session.currentOrderId = quote.orderId;
      }
      checkCancelled(controller.signal);
      const message: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        time: new Date().toISOString(),
        text: command.kind === 'confirm' ? '我请求确认此方案并提交售后申请。' : command.content,
      };
      session.busy = true;
      session.messages.push(message);
      await persist(); // Accept the turn only after the action is durable.

      try {
        events.open(() => controller.abort());
        events.send({ type: 'start', data: { busy: true, message } });
        checkCancelled(controller.signal);
        const onEvent = (event: TraceEvent) => {
          remember(session, event);
          events.send({ type: 'trace', data: event });
        };
        const result =
          command.kind === 'confirm'
            ? await conversation.confirmAndContinue(command.quoteId, onEvent, controller.signal)
            : await conversation.run(command.content, onEvent);
        recordResult(session, result);
        await persist(); // Never announce a successful result before the checkpoint commits.
        events.send({ type: 'result', data: await buildSessionSnapshot(this.service, session) });
      } catch (error) {
        const message = recordTurnFailure(session, error);
        try {
          await persist();
        } catch {
          this.options.logError('会话检查点保存失败；下一次读取将核对实际业务状态');
        }
        events.send({ type: 'error', data: { message } });
      }
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      await conversation?.close();
    }
  }
}
