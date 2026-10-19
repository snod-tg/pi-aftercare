import type { AftercareRequest, Order, Quote } from '../domain/types.js';

export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; time: string; status?: string }
export interface PolicyEvidence { citation: string; title: string; text: string; policyVersion: string; retrievedAt: string }
export interface ToolTrace { time: string; type: 'tool_start' | 'tool_end'; tool: string; ok?: boolean }
export interface QuoteView extends Quote { descriptions: string[] }
export interface SessionSummary { id: string; title: string; updatedAt: string; messageCount: number }
export interface WebSnapshot {
  id: string;
  busy: boolean;
  order: Order;
  messages: ChatMessage[];
  quotes: QuoteView[];
  requests: AftercareRequest[];
  evidence: PolicyEvidence[];
  trace: ToolTrace[];
  lastRun?: { status: string; modelCalls: number; toolCalls: number; tokens: number };
}
