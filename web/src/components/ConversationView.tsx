import { useEffect, useRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import Markdown from 'react-markdown';
import type { ChatMessage, ToolTrace, WebSnapshot } from '../../../src/http/web-types';
import { statusLabels, time, toolLabel } from '../presentation';
import { QuoteCard } from './QuoteCard';
import { ReceiptCard } from './ReceiptCard';
import { Welcome } from './Welcome';

interface ConversationViewProps {
  session: WebSnapshot | null;
  busy: boolean;
  loading: boolean;
  working: boolean;
  liveText: string;
  liveTools: ToolTrace[];
  onSend: (text: string) => void;
  onConfirm: (quoteId: string) => void;
}

export function ConversationView({
  session,
  busy,
  loading,
  working,
  liveText,
  liveTools,
  onSend,
  onConfirm,
}: ConversationViewProps) {
  const bottom = useRef<HTMLDivElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const sessionId = session?.id;
  const messageCount = session?.messages.length ?? 0;
  const toolCount = liveTools.length;
  const hasMessages = messageCount > 0;
  const latestTool = liveTools.at(-1);
  const runningTool =
    latestTool?.type === 'tool_start' ? toolLabel(latestTool.tool) : '正在整理回复';
  useEffect(() => {
    if (sessionId && (messageCount || liveText || toolCount))
      bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    else chatScroll.current?.scrollTo({ top: 0 });
  }, [sessionId, messageCount, liveText, toolCount]);
  return (
    <div className="chat-scroll" ref={chatScroll}>
      {!hasMessages && <Welcome disabled={!session || busy || loading} onSend={onSend} />}
      {hasMessages && (
        <div className="messages">
          <div className="date-divider">今天 · 售后对话</div>
          {session?.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {working && (
            <div className="message assistant">
              <span className="message-avatar">π</span>
              <div className="message-body">
                <div className="message-meta">
                  Aftercare
                  <span className="thinking">
                    <LoaderCircle size={12} /> {runningTool}
                  </span>
                </div>
                <div className="bubble streaming">
                  {liveText ? (
                    <Markdown>{liveText}</Markdown>
                  ) : (
                    <span className="typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
          {session?.busy && !working && (
            <div className="recovering">
              <LoaderCircle size={16} />
              正在恢复进行中的处理，你可以等待或停止。
            </div>
          )}
          {session?.quotes.map((quote) => (
            <QuoteCard
              key={quote.id}
              quote={quote}
              busy={busy}
              confirm={() => onConfirm(quote.id)}
            />
          ))}
          {session?.requests.map((request) => (
            <ReceiptCard key={request.id} request={request} />
          ))}
        </div>
      )}
      <div ref={bottom} />
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <div className={`message ${message.role}`}>
      {message.role === 'assistant' && <span className="message-avatar">π</span>}
      <div className="message-body">
        <div className="message-meta">
          {message.role === 'assistant' ? 'Aftercare' : '你'}
          <span>{time(message.time)}</span>
        </div>
        <div className="bubble">
          {message.role === 'assistant' ? <Markdown>{message.text}</Markdown> : message.text}
        </div>
        {message.status && message.status !== 'completed' && (
          <div className="run-status">{statusLabels[message.status]}</div>
        )}
      </div>
    </div>
  );
}
