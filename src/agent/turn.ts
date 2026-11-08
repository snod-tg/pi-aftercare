import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

export interface TraceEvent {
  time: string;
  type: 'text' | 'tool_start' | 'tool_end';
  text?: string;
  tool?: string;
  ok?: boolean;
  data?: unknown;
  orderId?: string;
}

export type RunStatus =
  | 'completed'
  | 'model_error'
  | 'model_limit'
  | 'tool_limit'
  | 'timeout'
  | 'cancelled';
export type StopReason = Exclude<RunStatus, 'completed' | 'model_error'>;

function successfulOrderId(name: string, details: unknown) {
  if (!details || typeof details !== 'object') return undefined;
  if (name === 'get_order' && 'id' in details && typeof details.id === 'string') return details.id;
  if (name === 'quote_aftercare' && 'orderId' in details && typeof details.orderId === 'string')
    return details.orderId;
  return undefined;
}

export class AgentTurn {
  reason?: StopReason;
  modelCalls = 0;
  toolCalls = 0;
  invalidGeneration = false;
  text = '';
  failure?: string;
  readonly trace: TraceEvent[] = [];

  constructor(private readonly onEvent?: (event: TraceEvent) => void) {}

  private emit(event: Omit<TraceEvent, 'time'>) {
    const entry = { ...event, time: new Date().toISOString() };
    if (this.trace.length < 120) this.trace.push(entry);
    this.onEvent?.(entry);
  }

  recordFailure(error: unknown) {
    this.failure ??= error instanceof Error ? error.message : '模型 API 请求失败';
  }

  handle(event: AgentSessionEvent) {
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta')
          this.emit({ type: 'text', text: event.assistantMessageEvent.delta });
        break;
      case 'tool_execution_start':
        this.emit({ type: 'tool_start', tool: event.toolName });
        break;
      case 'tool_execution_end': {
        const details: unknown = event.result.details;
        const orderId = event.isError ? undefined : successfulOrderId(event.toolName, details);
        this.emit({
          type: 'tool_end',
          tool: event.toolName,
          ok: !event.isError,
          ...(orderId ? { orderId } : {}),
          ...(event.toolName === 'search_aftercare_policy' && !event.isError
            ? { data: details }
            : {}),
        });
        break;
      }
      case 'message_end': {
        const message = event.message;
        if (message.role !== 'assistant') break;
        this.text = message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
        if (message.stopReason === 'error') {
          this.invalidGeneration = true;
          this.failure ??= message.errorMessage ?? '模型 API 请求失败';
        } else if (message.stopReason === 'length') {
          this.invalidGeneration = true;
          this.failure ??= '模型输出达到上限，本轮结果可能不完整';
        }
        break;
      }
    }
  }
}
