import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AftercareBackend, OperationResult } from '../domain/backend.js';
import { DomainError } from '../domain/errors.js';
import type { Actor, Quote } from '../domain/types.js';
import { createConnectedModel, type ModelConnection } from './model-connection.js';
import { readPositiveInteger } from '../env.js';
import {
  restoreSessionManager,
  type ConfirmationReceipt,
  type ConversationCheckpoint,
} from './checkpoint.js';
import { createAftercareSession } from './session.js';
import type { ToolHooks } from './tools.js';
import { AgentTurn, type RunStatus, type StopReason, type TraceEvent } from './turn.js';

export type { ConfirmationReceipt, ConversationCheckpoint } from './checkpoint.js';
export type { RunStatus, TraceEvent } from './turn.js';

export interface RunLimits {
  maxModelCalls: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export function readRunLimits(env: NodeJS.ProcessEnv = process.env): RunLimits {
  return {
    maxModelCalls: readPositiveInteger(env, 'AGENT_MAX_MODEL_CALLS', 8),
    maxToolCalls: readPositiveInteger(env, 'AGENT_MAX_TOOL_CALLS', 24),
    timeoutMs: readPositiveInteger(env, 'AGENT_TIMEOUT_MS', 120_000),
  };
}

export interface ConversationRestore {
  checkpoint?: ConversationCheckpoint;
  onCheckpoint?: () => Promise<void>;
}

export interface RunResult {
  status: RunStatus;
  text: string;
  error?: string;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  trace: TraceEvent[];
  pendingQuotes: Quote[];
  operations: OperationResult[];
}

type ToolInterceptor = { run<T>(tool: string, operation: () => T | Promise<T>): Promise<T> };

interface ConversationOptions extends ConversationRestore {
  service: AftercareBackend;
  actor: Actor;
  connection: ModelConnection;
  limits?: RunLimits;
  fetch?: typeof globalThis.fetch;
  restorePendingQuotes?: boolean;
  faults?: ToolInterceptor;
  confirmationMode?: 'web' | 'cli';
}

export class AgentConversation {
  private session!: AgentSession;
  private readonly quotes = new Map<string, Quote>();
  private readonly receipts = new Map<string, ConfirmationReceipt>();
  private activeTurn: AgentTurn | undefined;
  private disposed = false;

  private constructor(
    private readonly service: AftercareBackend,
    private readonly actor: Actor,
    private readonly connection: ModelConnection,
    private readonly limits: RunLimits,
    private readonly checkpoint?: () => Promise<void>,
  ) {}

  static async create(options: ConversationOptions) {
    const limits = { ...readRunLimits({}), ...options.limits };
    if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new Error('运行限制必须是正整数');

    const actor = Object.freeze({ ...options.actor });
    const manager = restoreSessionManager(options.checkpoint, actor);
    const conversation = new AgentConversation(
      options.service,
      actor,
      options.connection,
      limits,
      options.onCheckpoint,
    );
    conversation.restoreBusinessState(options.checkpoint);

    const { modelRuntime, model } = await createConnectedModel(options.connection);
    const { session } = await createAftercareSession({
      service: options.service,
      actor,
      modelRuntime,
      model,
      sessionManager: manager,
      ...(options.confirmationMode ? { confirmationMode: options.confirmationMode } : {}),
      toolHooks: conversation.createToolHooks(options.faults),
    });
    conversation.session = session;
    try {
      if (options.restorePendingQuotes) {
        for (const quote of await options.service.listPendingQuotes(actor))
          conversation.quotes.set(quote.id, quote);
      }
      conversation.installModelGuards(options.fetch);
      return conversation;
    } catch (error) {
      await conversation.close();
      throw error;
    }
  }

  private restoreBusinessState(checkpoint?: ConversationCheckpoint) {
    if (!checkpoint) return;
    for (const quote of checkpoint.quotes) this.quotes.set(quote.id, structuredClone(quote));
    for (const receipt of checkpoint.receipts) this.receipts.set(receipt.quoteId, { ...receipt });
  }

  private createToolHooks(interceptor?: ToolInterceptor): ToolHooks {
    return {
      aroundTool: async (name, operation) => {
        await this.checkpoint?.();
        const result = await (interceptor ? interceptor.run(name, operation) : operation());
        await this.checkpoint?.();
        return result;
      },
      beforeTool: () => this.beforeTool(),
      onQuote: (quote) => this.rememberQuote(quote),
      authorizeCreate: (input) => this.authorizeCreate(input),
    };
  }

  private rememberQuote(quote: Quote) {
    for (const [id, old] of this.quotes) {
      if (old.orderId === quote.orderId) this.quotes.delete(id);
    }
    this.quotes.set(quote.id, quote);
  }

  private authorizeCreate(input: ConfirmationReceipt) {
    const receipt = this.receipts.get(input.quoteId);
    if (
      !this.quotes.has(input.quoteId) ||
      !receipt ||
      receipt.confirmationId !== input.confirmationId ||
      receipt.idempotencyKey !== input.idempotencyKey
    ) {
      throw new DomainError(
        'USER_CONFIRMATION_REQUIRED',
        '需要应用记录的当前方案确认，不能由模型或聊天文字生成',
        409,
      );
    }
  }

  private installModelGuards(customFetch?: typeof globalThis.fetch) {
    const originalStream = this.session.agent.streamFunction;
    const checkpoint = this.checkpoint;
    // The SDK has appended prior messages by the time the transport is called.
    const fetchWithCheckpoint: typeof globalThis.fetch | undefined = checkpoint
      ? async (input, init) => {
          await checkpoint();
          return (customFetch ?? globalThis.fetch)(input, init);
        }
      : customFetch;
    this.session.agent.streamFunction = (model, context, options) => {
      const turn = this.activeTurn;
      if (!turn || turn.reason) throw new Error(turn?.reason ?? '没有执行中的轮次');
      if (turn.invalidGeneration) throw new Error('模型输出不完整，本轮已停止');
      if (turn.modelCalls >= this.limits.maxModelCalls) {
        turn.reason = 'model_limit';
        throw new Error('本轮模型请求次数已达上限');
      }
      turn.modelCalls += 1;
      return originalStream(model, context, {
        ...options,
        maxTokens: this.connection.maxOutputTokens,
        maxRetries: 0,
        ...(fetchWithCheckpoint ? { fetch: fetchWithCheckpoint } : {}),
      });
    };
  }

  exportCheckpoint(): ConversationCheckpoint {
    const manager = this.session.sessionManager;
    const header = manager.getHeader();
    if (!header) throw new Error('Pi 会话记录缺少头信息');
    const checkpoint: ConversationCheckpoint = structuredClone({
      version: 1,
      entries: [header, ...manager.getBranch()],
      quotes: [...this.quotes.values()],
      receipts: [...this.receipts.values()],
    });
    // A provider's error text may echo credentials; never persist the configured key.
    return !this.connection.apiKey || this.connection.apiKey === 'local'
      ? checkpoint
      : (JSON.parse(
          JSON.stringify(checkpoint, (_key, value: unknown) =>
            typeof value === 'string'
              ? value.replaceAll(this.connection.apiKey, '[redacted]')
              : value,
          ),
        ) as ConversationCheckpoint);
  }

  private beforeTool() {
    const turn = this.activeTurn;
    if (!turn || turn.reason) throw new Error('当前轮次已停止，不能继续执行工具');
    if (turn.invalidGeneration)
      throw new DomainError('MODEL_OUTPUT_INCOMPLETE', '截断或失败的模型输出不得执行工具', 409);
    if (turn.toolCalls >= this.limits.maxToolCalls) {
      this.stop('tool_limit');
      throw new Error('本轮工具执行次数已达上限');
    }
    turn.toolCalls += 1;
  }

  private ensureReady() {
    if (this.disposed) throw new Error('会话已关闭');
    if (this.activeTurn) throw new Error('上一轮仍在执行，请先等待或取消');
  }

  async pendingQuotes() {
    const pending: Quote[] = [];
    for (const quote of this.quotes.values()) {
      const receipt = this.receipts.get(quote.id);
      if (
        !receipt ||
        (await this.service.getOperation(this.actor, receipt.idempotencyKey)).status !== 'completed'
      )
        pending.push(structuredClone(quote));
    }
    return pending;
  }

  // This method is for a deliberate host/UI action, never registered as a model tool.
  async confirm(quoteId: string): Promise<ConfirmationReceipt> {
    this.ensureReady();
    if (!this.quotes.has(quoteId))
      throw new DomainError('UNKNOWN_QUOTE', '该方案不属于本会话的当前方案', 404);
    const previous = this.receipts.get(quoteId);
    if (previous) return { ...previous };
    const confirmation = await this.service.confirmQuote(this.actor, quoteId);
    const receipt = {
      quoteId,
      confirmationId: confirmation.id,
      idempotencyKey: confirmation.idempotencyKey,
    };
    this.receipts.set(quoteId, receipt);
    // Persist the stable approval before any model is allowed to submit a write.
    await this.checkpoint?.();
    return { ...receipt };
  }

  async confirmAndContinue(
    quoteId: string,
    onEvent?: (event: TraceEvent) => void,
    signal?: AbortSignal,
  ) {
    const checkCancelled = () => {
      if (signal?.aborted)
        throw new DomainError('RUN_CANCELLED', '本轮已停止，可继续查询实际申请状态', 409);
    };
    checkCancelled();
    const receipt = await this.confirm(quoteId);
    checkCancelled();
    return this.run(
      `应用已记录用户对下列方案的明确确认：\n${JSON.stringify(receipt)}\n请使用上述标识继续处理，先查询已有操作结果，必要时创建申请。`,
      onEvent,
    );
  }

  private stop(reason: StopReason) {
    if (!this.activeTurn) return;
    this.activeTurn.reason ??= reason;
    // Synchronously signal cancellation; never wait for idle from an Agent event handler.
    this.session.agent.abort();
  }

  cancel() {
    this.stop('cancelled');
  }

  async run(prompt: string, onEvent?: (event: TraceEvent) => void): Promise<RunResult> {
    this.ensureReady();
    if (!prompt.trim() || prompt.length > 4000) throw new Error('每条消息须为 1–4000 个字符');
    if (this.session.getSessionStats().totalMessages >= 80)
      throw new Error('会话历史已较长，请使用 /reset 开始新会话');

    const turn = new AgentTurn(onEvent);
    this.activeTurn = turn;
    const tokensBefore = this.session.getSessionStats().tokens.total;
    try {
      await this.promptWithDeadline(prompt, turn);
      return await this.collectResult(turn, tokensBefore);
    } finally {
      this.activeTurn = undefined;
    }
  }

  private async promptWithDeadline(prompt: string, turn: AgentTurn) {
    const unsubscribe = this.session.subscribe((event) => turn.handle(event));
    const timer = setTimeout(() => this.stop('timeout'), this.limits.timeoutMs);
    try {
      await this.session.prompt(prompt, { expandPromptTemplates: false });
    } catch (error) {
      turn.recordFailure(error);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }

  private async collectResult(turn: AgentTurn, tokensBefore: number): Promise<RunResult> {
    const failure =
      turn.failure && this.connection.apiKey !== 'local'
        ? turn.failure.replaceAll(this.connection.apiKey, '[redacted]')
        : turn.failure;
    const status = turn.reason ?? (failure ? 'model_error' : 'completed');
    return {
      status,
      text: turn.text,
      ...(failure ? { error: failure.slice(0, 500) } : {}),
      modelCalls: turn.modelCalls,
      toolCalls: turn.toolCalls,
      tokens: this.session.getSessionStats().tokens.total - tokensBefore,
      trace: turn.trace,
      pendingQuotes: await this.pendingQuotes(),
      // Read back actual business results even if inference failed after a write.
      operations: await Promise.all(
        [...this.receipts.values()].map((receipt) =>
          this.service.getOperation(this.actor, receipt.idempotencyKey),
        ),
      ),
    };
  }

  async close() {
    if (this.disposed) return;
    if (this.activeTurn) {
      this.cancel();
      await this.session.abort();
    }
    this.session.dispose();
    this.disposed = true;
  }
}
