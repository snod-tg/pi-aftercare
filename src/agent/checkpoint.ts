import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import type { Actor, Quote } from '../domain/types.js';

export interface ConfirmationReceipt {
  quoteId: string;
  confirmationId: string;
  idempotencyKey: string;
}

export interface ConversationCheckpoint {
  version: 1;
  entries: FileEntry[];
  quotes: Quote[];
  receipts: ConfirmationReceipt[];
}

export function restoreSessionManager(
  checkpoint: ConversationCheckpoint | undefined,
  actor: Actor,
) {
  if (!checkpoint) return SessionManager.inMemory(process.cwd());
  if (checkpoint.version !== 1) throw new Error('不支持的会话记录版本');
  if (
    checkpoint.quotes.some(
      (quote) => quote.merchantId !== actor.merchantId || quote.customerId !== actor.customerId,
    )
  )
    throw new Error('会话方案归属不匹配');

  const manager = SessionManager.inMemory(process.cwd(), undefined, checkpoint.entries);
  // A crashed turn may have saved a tool call before its result. Never replay that call.
  const messages = manager.buildSessionContext().messages;
  const results = new Set(
    messages
      .filter((message) => message.role === 'toolResult')
      .map((message) => message.toolCallId),
  );
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall' || results.has(part.id)) continue;
      manager.appendMessage({
        role: 'toolResult',
        toolCallId: part.id,
        toolName: part.name,
        content: [
          {
            type: 'text',
            text: 'INTERRUPTED_TOOL: 上轮处理意外中断，工具结果未知；不要假定成功或重放旧写操作。先重新查询订单、库存和实际申请状态；已有幂等键必须复用。',
          },
        ],
        isError: true,
        timestamp: Date.now(),
      });
      results.add(part.id);
    }
  }
  return manager;
}
