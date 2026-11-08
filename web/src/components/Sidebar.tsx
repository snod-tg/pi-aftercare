import { FileText, MessageSquare, Plus, ShieldCheck } from 'lucide-react';
import type { SessionSummary } from '../../../src/http/web-types';
import { demoProfile } from '../demo-profile';

interface SidebarProps {
  history: SessionSummary[];
  selectedId: string | undefined;
  persistent: boolean;
  busy: boolean;
  loading: boolean;
  focusComposer: () => void;
  openDetails: () => void;
  newChat: () => Promise<void>;
  openHistory: (id: string) => Promise<void>;
}
export function Sidebar({
  history,
  selectedId,
  persistent,
  busy,
  loading,
  focusComposer,
  openDetails,
  newChat,
  openHistory,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Pi Aftercare 首页">
        <span className="brand-mark">
          π<span />
        </span>
        <span>
          Aftercare<small>让售后，简单一点。</small>
        </span>
      </a>
      <button className="new-chat" onClick={() => void newChat()} disabled={busy || loading}>
        <Plus size={17} />
        新的对话
      </button>
      <div className="nav-label">工作空间</div>
      <button className="nav-item active" onClick={focusComposer}>
        <MessageSquare size={17} />
        售后助手
        <span className="nav-dot" />
      </button>
      <button className="nav-item" onClick={openDetails}>
        <FileText size={17} />
        订单与处理记录
      </button>
      <div className="history-label">
        历史对话<span>{persistent ? '已保存' : '当前服务'}</span>
      </div>
      <div className="history-list" aria-label="历史对话">
        {history.map((item) => (
          <button
            key={item.id}
            className={selectedId === item.id ? 'selected' : ''}
            onClick={() => void openHistory(item.id)}
            disabled={busy || loading}
            title={item.title}
          >
            <MessageSquare size={13} />
            <span>
              {item.title}
              <small>
                {new Date(item.updatedAt).toLocaleDateString('zh-CN')} · {item.messageCount} 条消息
              </small>
            </span>
          </button>
        ))}
      </div>
      <div className="sidebar-note">
        <span className="small-icon">
          <ShieldCheck size={19} />
        </span>
        <strong>每一步，都由你决定</strong>
        <p>
          先了解方案，再确认提交。
          <br />
          所有售后操作都有记录。
        </p>
      </div>
      <div className="sidebar-bottom">
        <span className="avatar">A</span>
        <div>
          <strong>{demoProfile.name}</strong>
          <small>模拟顾客 · 本地演示</small>
        </div>
        <span className="online-dot" />
      </div>
    </aside>
  );
}
