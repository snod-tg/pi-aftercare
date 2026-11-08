import { useRef, useState } from 'react';
import { Package } from 'lucide-react';
import { ConversationView } from './components/ConversationView';
import { MessageComposer } from './components/MessageComposer';
import { SessionDetails } from './components/SessionDetails';
import { Sidebar } from './components/Sidebar';
import { useAftercareSession } from './useAftercareSession';

export function App() {
  const chat = useAftercareSession();
  const { session, meta, busy, loading, error, liveTools } = chat;
  const [showDetails, setShowDetails] = useState(false);
  const records = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const trace = [...(session?.trace ?? []), ...liveTools].slice(-30);

  return (
    <div className="app-shell">
      <Sidebar
        history={chat.history}
        selectedId={session?.id}
        persistent={Boolean(meta?.sessionPersistent)}
        busy={busy}
        loading={loading}
        focusComposer={() => input.current?.focus()}
        openDetails={() => {
          setShowDetails(true);
          records.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
        newChat={chat.newChat}
        openHistory={chat.openHistory}
      />
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间<span>/</span>
            <strong>售后助手</strong>
          </div>
          <div className="demo-pill">
            <span />
            模拟商家
          </div>
        </header>
        <div className="workspace">
          <section className="conversation" aria-label="售后对话">
            <div className="conversation-heading">
              <div>
                <span className="eyebrow">YOUR AFTERCARE ASSISTANT</span>
                <h1>
                  售后助手<span className="assistant-badge">AI</span>
                </h1>
                <p>查询政策、办理退换货，交给我来协助。</p>
              </div>
              <button
                className="icon-button detail-toggle"
                aria-label="查看订单与处理记录"
                onClick={() => setShowDetails((v) => !v)}
              >
                <Package size={20} />
              </button>
              <span className="service-status">
                <span className={error ? 'status-dot warning' : 'status-dot'} />
                {loading ? '正在连接' : session ? '会话已就绪' : '等待连接'}
              </span>
            </div>
            <ConversationView
              session={session}
              busy={busy}
              loading={loading}
              working={chat.working}
              liveText={chat.liveText}
              liveTools={liveTools}
              onSend={(text) => void chat.sendMessage(text)}
              onConfirm={(id) => void chat.confirmQuote(id)}
            />
            <MessageComposer
              key={session?.id}
              input={input}
              connected={Boolean(session)}
              loading={loading}
              busy={busy}
              error={error}
              clearError={chat.clearError}
              reconnect={chat.initialize}
              onSend={chat.sendMessage}
              cancel={chat.cancel}
            />
          </section>
          <SessionDetails
            session={session}
            meta={meta}
            trace={trace}
            records={records}
            showDetails={showDetails}
            closeDetails={() => setShowDetails(false)}
          />
        </div>
      </main>
    </div>
  );
}
