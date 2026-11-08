import { type RefObject, useState } from 'react';
import { ArrowUp, ShieldCheck, Square, X } from 'lucide-react';
import { demoProfile } from '../demo-profile';

interface ComposerProps {
  input: RefObject<HTMLTextAreaElement | null>;
  connected: boolean;
  loading: boolean;
  busy: boolean;
  error: string;
  clearError: () => void;
  reconnect: () => Promise<void>;
  onSend: (text: string) => Promise<boolean>;
  cancel: () => Promise<void>;
}
export function MessageComposer({
  input,
  connected,
  loading,
  busy,
  error,
  clearError,
  reconnect,
  onSend,
  cancel,
}: ComposerProps) {
  const [draft, setDraft] = useState('');
  const submit = async () => {
    if (!connected || busy || loading || !draft.trim()) return;
    if (await onSend(draft)) setDraft((current) => (current === draft ? '' : current));
    input.current?.focus();
  };
  return (
    <div className="composer-area">
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          {!connected && <button onClick={() => void reconnect()}>重新连接</button>}
          <button aria-label="关闭错误提示" onClick={clearError}>
            <X size={15} />
          </button>
        </div>
      )}
      <form
        className={`composer ${busy ? 'is-busy' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          maxLength={4000}
          rows={2}
          placeholder={`例如：订单 ${demoProfile.orderId}，T 恤换 L 码，外套想退货…`}
          aria-label="输入售后需求"
          disabled={!connected || loading || busy}
        />
        <div className="composer-toolbar">
          <span>
            <ShieldCheck size={14} />
            确认前不会提交售后申请
          </span>
          {busy ? (
            <button type="button" className="stop-button" onClick={() => void cancel()}>
              <Square size={12} />
              停止
            </button>
          ) : (
            <button
              type="submit"
              className="send-button"
              aria-label="发送消息"
              disabled={!draft.trim() || !connected || loading}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
      </form>
      <div className="composer-footnote">
        AI 可能出错，请核对方案和政策依据。<span>Enter 发送 · Shift + Enter 换行</span>
      </div>
    </div>
  );
}
