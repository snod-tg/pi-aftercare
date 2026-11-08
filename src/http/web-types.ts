import type { RunStatus, TraceEvent } from '../agent/conversation.js';
import type { AftercareRequest, Order, Quote } from '../domain/types.js';

export interface ServiceMeta {
  service: string;
  demo: boolean;
  configured: boolean;
  model: string;
  persistent: boolean;
  sessionPersistent: boolean;
}

export type MessageStatus = RunStatus | 'interrupted';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  time: string;
  status?: MessageStatus;
}
export interface PolicyEvidence {
  citation: string;
  title: string;
  text: string;
  policyVersion: string;
  retrievedAt: string;
}
export interface ToolTrace {
  time: string;
  type: 'tool_start' | 'tool_end';
  tool: string;
  ok?: boolean;
}
export interface QuoteView extends Quote {
  descriptions: string[];
}
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}
export interface WebSnapshot {
  id: string;
  busy: boolean;
  order: Order | null;
  messages: ChatMessage[];
  quotes: QuoteView[];
  requests: AftercareRequest[];
  evidence: PolicyEvidence[];
  trace: ToolTrace[];
  lastRun?: { status: RunStatus; modelCalls: number; toolCalls: number; tokens: number };
}

export type WebTurnEvent =
  | { type: 'start'; data: { busy: true; message: ChatMessage } }
  | { type: 'trace'; data: TraceEvent }
  | { type: 'result'; data: WebSnapshot }
  | { type: 'error'; data: { message: string } };
