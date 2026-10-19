import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { ArrowRight, ArrowUp, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, FileText, LoaderCircle, MessageSquare, Package, Plus, RotateCcw, ShieldCheck, Shirt, Square, X } from 'lucide-react';
import { api, ApiError, restoreSession, streamTurn, type QuoteView, type WebSnapshot } from './api';
import type { ToolTrace, SessionSummary } from '../../src/http/web-types';
const money = (cents: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100);
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const toolLabels: Record<string, string> = {
  get_order: '查询订单', get_aftercare_policy: '核对售后规则', search_aftercare_policy: '检索政策依据',
  list_variants: '查询尺码库存', quote_aftercare: '生成退换货方案', create_aftercare_request: '提交售后申请', get_request_status: '核对申请状态',
};
const key = 'pi-aftercare-session-v1';
const suggestions = ['T 恤想换成 L 码，外套想退掉', '这笔订单还能退换货吗？', '帮我查一下 T 恤有哪些尺码'];
const statusLabels: Record<string, string> = { interrupted: '服务中断，已恢复保存的记录', model_error: '模型响应异常，可重试', timeout: '处理超时，可重试', cancelled: '已停止处理', model_limit: '达到本轮模型调用上限', tool_limit: '达到本轮工具调用上限' };

export function App() {
  const [session, setSession] = useState<WebSnapshot | null>(null);
  const [meta, setMeta] = useState<{ configured: boolean; model: string; persistent: boolean; sessionPersistent: boolean }>();
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState('');
  const [liveTools, setLiveTools] = useState<ToolTrace[]>([]);
  const [error, setError] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [now, setNow] = useState(Date.now());
  const bottom = useRef<HTMLDivElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const records = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lock = useRef(false);
  const initialized = useRef(false);
  const busy = working || Boolean(session?.busy);
  const refreshHistory = async () => {
    try { setHistory((await api<{ sessions: SessionSummary[] }>('/sessions')).sessions); }
    catch { /* A transient history failure should not discard the active conversation. */ }
  };
  const accept = (value: WebSnapshot) => { setSession(value); localStorage.setItem(key, value.id); void refreshHistory(); };

  const initialize = async () => {
    setLoading(true); setError('');
    try {
      const metadata = await api<{ configured: boolean; model: string; persistent: boolean; sessionPersistent: boolean }>('/meta'); setMeta(metadata);
      const id = localStorage.getItem(key);
      if (id) {
        try { accept(await restoreSession(id)); return; }
        catch (e) { if (!(e instanceof ApiError) || e.status !== 404) throw e; localStorage.removeItem(key); }
      }
      accept(await api<WebSnapshot>('/sessions', 'POST', {}));
    } catch (e) { setError(e instanceof Error ? e.message : '连接失败'); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (!initialized.current) { initialized.current = true; void initialize(); } }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (session?.messages.length || live || liveTools.length) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    else chatScroll.current?.scrollTo({ top: 0 });
  }, [session?.id, session?.messages.length, live, liveTools.length]);
  // Recover an in-flight turn after a page refresh or transport interruption.
  useEffect(() => {
    if (!session?.busy || working) return;
    const id = session.id;
    const timer = setInterval(() => { void restoreSession(id).then(setSession).catch(() => setError('无法恢复会话状态，请检查后台服务')); }, 2000);
    return () => clearInterval(timer);
  }, [session?.id, session?.busy, working]);

  const newChat = async () => {
    if (lock.current || busy) return;
    lock.current = true; setLoading(true); setError('');
    try {
      localStorage.removeItem(key); setSession(null);
      accept(await api<WebSnapshot>('/sessions', 'POST', {})); setLive(''); setLiveTools([]);
    } catch (e) { setError(e instanceof Error ? e.message : '创建会话失败'); }
    finally { lock.current = false; setLoading(false); }
  };
  const openHistory = async (id: string) => {
    if (busy || loading || lock.current || id === session?.id) return;
    lock.current = true; setLoading(true); setError('');
    try { accept(await restoreSession(id)); setLive(''); setLiveTools([]); setDraft(''); }
    catch (e) { setError(e instanceof Error ? e.message : '恢复会话失败'); }
    finally { lock.current = false; setLoading(false); }
  };
  const turn = async (content: string, quoteId?: string) => {
    if (!session || lock.current || busy || (!quoteId && !content.trim())) return;
    const id = session.id;
    lock.current = true; setWorking(true); setError(''); setLive(''); setLiveTools([]);
    if (!quoteId) setDraft('');
    setSession(s => s ? { ...s, messages: [...s.messages, { id: crypto.randomUUID(), role: 'user', text: quoteId ? '我已确认方案，请提交售后申请。' : content.trim(), time: new Date().toISOString() }] } : s);
    try {
      await streamTurn(id, quoteId ? 'confirm' : 'messages', quoteId ? { quoteId } : { content: content.trim() }, (event, value) => {
        if (event === 'trace') {
          const trace = value as ({ type: 'text'; text: string } | ToolTrace);
          if (trace.type === 'text') setLive(text => text + (trace.text ?? ''));
          else setLiveTools(tools => [...tools, trace]);
        } else if (event === 'result') accept(value as WebSnapshot);
        else if (event === 'error') setError((value as { message: string }).message);
      });
    } catch (e) { setError(e instanceof Error ? e.message : '连接中断，请重试'); }
    finally {
      try { accept(await restoreSession(id)); } catch { /* Keep the last known state and the visible error. */ }
      setWorking(false); lock.current = false; setLive(''); setLiveTools([]); input.current?.focus();
    }
  };
  const cancel = async () => {
    if (!session) return;
    try { await api(`/sessions/${session.id}/cancel`, 'POST', {}); }
    catch { setError('停止请求未送达，请检查后台连接'); }
  };
  const trace = [...(session?.trace ?? []), ...liveTools].slice(-30);
  const latestTool = liveTools.at(-1);
  const runningTool = latestTool?.type === 'tool_start' ? toolLabels[latestTool.tool] ?? latestTool.tool : '正在整理回复';
  const hasMessages = Boolean(session?.messages.length);

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Pi Aftercare 首页"><span className="brand-mark">π<span/></span><span>Aftercare<small>让售后，简单一点。</small></span></a>
      <button className="new-chat" onClick={() => void newChat()} disabled={busy || loading}><Plus size={17}/>新的对话</button>
      <div className="nav-label">工作空间</div>
      <button className="nav-item active" onClick={() => input.current?.focus()}><MessageSquare size={17}/>售后助手<span className="nav-dot"/></button>
      <button className="nav-item" onClick={() => { setShowDetails(true); records.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}><FileText size={17}/>订单与处理记录</button>
      <div className="history-label">历史对话<span>{meta?.sessionPersistent ? '已保存' : '当前服务'}</span></div>
      <div className="history-list" aria-label="历史对话">{history.map(item => <button key={item.id} className={session?.id === item.id ? 'selected' : ''} onClick={() => void openHistory(item.id)} disabled={busy || loading} title={item.title}><MessageSquare size={13}/><span>{item.title}<small>{new Date(item.updatedAt).toLocaleDateString('zh-CN')} · {item.messageCount} 条消息</small></span></button>)}</div>
      <div className="sidebar-note"><span className="small-icon"><ShieldCheck size={19}/></span><strong>每一步，都由你决定</strong><p>先了解方案，再确认提交。<br/>所有售后操作都有记录。</p></div>
      <div className="sidebar-bottom"><span className="avatar">A</span><div><strong>Alice</strong><small>模拟顾客 · 本地演示</small></div><span className="online-dot"/></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumb">工作空间<span>/</span><strong>售后助手</strong></div><div className="demo-pill"><span/>模拟商家</div></header>
      <div className="workspace">
        <section className="conversation" aria-label="售后对话">
          <div className="conversation-heading"><div><span className="eyebrow">YOUR AFTERCARE ASSISTANT</span><h1>售后助手<span className="assistant-badge">AI</span></h1><p>查询政策、办理退换货，交给我来协助。</p></div><button className="icon-button detail-toggle" aria-label="查看订单与处理记录" onClick={() => setShowDetails(v => !v)}><Package size={20}/></button><span className="service-status"><span className={error ? 'status-dot warning' : 'status-dot'}/>{loading ? '正在连接' : session ? '会话已就绪' : '等待连接'}</span></div>
          <div className="chat-scroll" ref={chatScroll}>
            {!hasMessages && <div className="welcome"><div className="welcome-symbol"><Shirt size={34} strokeWidth={1.4}/><span><Check size={12}/></span></div><h2>你好，Alice 👋</h2><p>衣服的尺码不合适，或是改变了主意？<br/>告诉我你的需求，我们一起处理。</p><div className="suggestions">{suggestions.map((text, i) => <button key={text} disabled={!session || busy || loading} onClick={() => void turn(`订单 O-1001，${text}`)}><span>{i === 0 ? <RotateCcw size={17}/> : i === 1 ? <CircleHelp size={17}/> : <Shirt size={17}/>}</span>{text}<ArrowRight size={15}/></button>)}</div><div className="welcome-hint"><ShieldCheck size={13}/>生成方案后，需要你确认才会提交申请</div></div>}
            {hasMessages && <div className="messages"><div className="date-divider">今天 · 售后对话</div>{session?.messages.map(message => <div key={message.id} className={`message ${message.role}`}>
              {message.role === 'assistant' && <span className="message-avatar">π</span>}<div className="message-body"><div className="message-meta">{message.role === 'assistant' ? 'Aftercare' : '你'}<span>{time(message.time)}</span></div><div className="bubble">{message.role === 'assistant' ? <Markdown>{message.text}</Markdown> : message.text}</div>{message.status && message.status !== 'completed' && <div className="run-status">{statusLabels[message.status] ?? message.status}</div>}</div>
            </div>)}
            {working && <div className="message assistant"><span className="message-avatar">π</span><div className="message-body"><div className="message-meta">Aftercare<span className="thinking"><LoaderCircle size={12}/> {runningTool}</span></div><div className="bubble streaming">{live ? <Markdown>{live}</Markdown> : <span className="typing"><i/><i/><i/></span>}</div></div></div>}
            {session?.busy && !working && <div className="recovering"><LoaderCircle size={16}/>正在恢复进行中的处理，你可以等待或停止。</div>}
            {session?.quotes.map(quote => <QuoteCard key={quote.id} quote={quote} busy={busy} now={now} confirm={() => void turn('', quote.id)}/>)}
            {session?.requests.map(request => <div className="receipt" key={request.id}><div className="receipt-heading"><span><CheckCheck size={20}/></span><div><strong>售后申请已创建</strong><small>来自后台的申请回执</small></div><span className="receipt-status">等待寄回</span></div><div className="receipt-row"><span>申请编号</span><code>{request.id}</code></div><div className="receipt-row"><span>预计退款</span><strong>{money(request.refundCents)}</strong></div><p>请等待后续寄回指引。退款尚未开始，本演示不处理真实资金。</p></div>)}
            </div>}
            <div ref={bottom}/>
          </div>
          <div className="composer-area">
            {error && <div className="error-banner" role="alert"><span>{error}</span>{!session && <button onClick={() => void initialize()}>重新连接</button>}<button aria-label="关闭错误提示" onClick={() => setError('')}><X size={15}/></button></div>}
            <form className={`composer ${busy ? 'is-busy' : ''}`} onSubmit={event => { event.preventDefault(); void turn(draft); }}>
              <textarea ref={input} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void turn(draft); } }} maxLength={4000} rows={2} placeholder="例如：订单 O-1001，T 恤换 L 码，外套想退货…" aria-label="输入售后需求" disabled={!session || loading || busy}/>
              <div className="composer-toolbar"><span><ShieldCheck size={14}/>确认前不会提交售后申请</span>{busy ? <button type="button" className="stop-button" onClick={() => void cancel()}><Square size={12}/>停止</button> : <button type="submit" className="send-button" aria-label="发送消息" disabled={!draft.trim() || !session || loading}><ArrowUp size={19}/></button>}</div>
            </form><div className="composer-footnote">AI 可能出错，请核对方案和政策依据。<span>Enter 发送 · Shift + Enter 换行</span></div>
          </div>
        </section>
        <aside className={`context-panel ${showDetails ? 'mobile-open' : ''}`} aria-label="订单与处理记录"><div className="context-title"><h2>本次售后</h2><button className="icon-button mobile-close" aria-label="关闭订单与处理记录" onClick={() => setShowDetails(false)}><X size={18}/></button><span>ORDER CONTEXT</span></div>
          <section className="order-card"><div className="order-heading"><span><Package size={16}/>当前订单</span><strong className="delivered">{session?.order.status === 'delivered' ? '已签收' : session ? '待签收' : '加载中'}</strong></div><div className="order-id">{session?.order.id ?? '—'}<span>模拟订单</span></div><div className="order-items">{session?.order.lines.map((line, i) => <div className="order-item" key={line.id}><div className={`product-icon product-${i}`}><Shirt size={27} strokeWidth={1.4}/></div><div className="product-info"><strong>{line.name}</strong><small>数量 {line.quantity} · 已申请 {line.requestedQuantity}</small><span>{money(line.paidUnitCents)}</span></div></div>)}</div><div className="order-total"><span>订单实付</span><strong>{session ? money(session.order.lines.reduce((sum, line) => sum + line.paidUnitCents * line.quantity, 0)) : '—'}</strong></div></section>
          <section className="evidence-section"><div className="section-heading"><h3><ShieldCheck size={16}/>政策依据</h3><span>{session?.evidence.length ?? 0} 条</span></div>{!session?.evidence.length ? <div className="empty-evidence"><FileText size={21}/><p>助手查询政策后，<br/>相关条款会展示在这里。</p></div> : session.evidence.map(evidence => <details className="evidence-card" key={evidence.citation}><summary><span>{evidence.title}</span><ChevronDown size={14}/></summary><p>{evidence.text}</p><small>{evidence.citation}</small><small>政策 {evidence.policyVersion} · 检索于 {time(evidence.retrievedAt)}</small></details>)}</section>
          <section ref={records} className="trace-section"><div className="section-heading"><h3><Clock3 size={16}/>处理记录</h3><span>{trace.filter(t => t.type === 'tool_end').length} 次工具结果</span></div>{trace.length ? <ol className="trace-list">{trace.slice(-12).map((event, index) => <li key={`${index}-${event.time}`}><span className={`trace-dot ${event.type === 'tool_start' ? 'pending' : event.ok ? 'ok' : 'failed'}`}>{event.type === 'tool_end' && event.ok && <Check size={9}/>}</span><div><strong>{toolLabels[event.tool] ?? event.tool}</strong><small>{time(event.time)} · {event.type === 'tool_start' ? '开始' : event.ok ? '执行成功' : '执行失败'}</small></div></li>)}</ol> : <p className="empty-trace">发送需求后，这里会显示实际处理过程。</p>}{session?.lastRun && <div className="run-stats">本轮 {session.lastRun.modelCalls} 次模型调用 · {session.lastRun.toolCalls} 次工具调用<br/>{session.lastRun.tokens.toLocaleString()} tokens · {session.lastRun.status === 'completed' ? '本轮处理结束' : statusLabels[session.lastRun.status] ?? session.lastRun.status}</div>}</section>
          <div className="context-footer"><span className="status-dot"/>Pi Agent SDK<span>·</span>{meta?.model || '外部模型 API'}<br/><small>{meta?.persistent ? '业务数据由 PostgreSQL 保存' : '演示数据保存在内存中'} · {meta?.sessionPersistent ? '对话已持久化保存' : '对话仅当前服务有效'}</small></div>
        </aside>
      </div>
    </main>
  </div>;
}

function QuoteCard({ quote, busy, now, confirm }: { quote: QuoteView; busy: boolean; now: number; confirm: () => void }) {
  const expired = now >= Date.parse(quote.expiresAt);
  return <div className="quote-card"><div className="quote-heading"><span><FileText size={17}/>请确认退换货方案</span><span className="quote-tag">{expired ? '已过期' : '待你确认'}</span></div><div className="quote-lines">{quote.descriptions.map((description, i) => <div key={i}><Check size={14}/>{description}</div>)}</div><div className="quote-refund"><span>预计退款</span><strong>{money(quote.refundCents)}</strong></div><div className="quote-bottom"><small><Clock3 size={12}/>{expired ? '请让助手重新生成方案' : `有效至 ${time(quote.expiresAt)}`}</small><button onClick={confirm} disabled={busy || expired}>确认并提交<ArrowRight size={15}/></button></div><details className="quote-reference"><summary>查看方案编号<ChevronDown size={12}/></summary><code>{quote.id}</code><span>政策版本：{quote.policyVersion}</span></details></div>;
}
