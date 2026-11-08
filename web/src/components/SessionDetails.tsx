import type { RefObject } from 'react';
import { Check, ChevronDown, Clock3, FileText, Package, ShieldCheck, Shirt, X } from 'lucide-react';
import type {
  OrderView,
  PolicyEvidence,
  ServiceMeta,
  ToolTrace,
  WebSnapshot,
} from '../../../src/http/web-types';
import { money, statusLabels, time, toolLabel } from '../presentation';

interface SessionDetailsProps {
  session: WebSnapshot | null;
  meta: ServiceMeta | undefined;
  trace: ToolTrace[];
  records: RefObject<HTMLElement | null>;
  showDetails: boolean;
  closeDetails: () => void;
}
export function SessionDetails({
  session,
  meta,
  trace,
  records,
  showDetails,
  closeDetails,
}: SessionDetailsProps) {
  return (
    <aside
      className={`context-panel ${showDetails ? 'mobile-open' : ''}`}
      aria-label="订单与处理记录"
    >
      <div className="context-title">
        <h2>本次售后</h2>
        <button
          className="icon-button mobile-close"
          aria-label="关闭订单与处理记录"
          onClick={closeDetails}
        >
          <X size={18} />
        </button>
        <span>ORDER CONTEXT</span>
      </div>
      <OrderPanel order={session?.order ?? null} />
      <PolicyPanel evidence={session?.evidence ?? []} />
      <TracePanel records={records} trace={trace} lastRun={session?.lastRun} />
      <div className="context-footer">
        <span className="status-dot" />
        Pi Agent SDK<span>·</span>
        {meta?.model || '外部模型 API'}
        <br />
        <small>
          {meta?.persistent ? '业务数据由 PostgreSQL 保存' : '演示数据保存在内存中'} ·{' '}
          {meta?.sessionPersistent ? '对话已持久化保存' : '对话仅当前服务有效'}
        </small>
      </div>
    </aside>
  );
}
function OrderPanel({ order }: { order: OrderView | null }) {
  return (
    <section className="order-card">
      <div className="order-heading">
        <span>
          <Package size={16} />
          当前订单
        </span>
        <strong className="delivered">
          {order?.status === 'delivered' ? '已签收' : order ? '待签收' : '未选择订单'}
        </strong>
      </div>
      <div className="order-id">
        {order?.id ?? '—'}
        <span>模拟订单</span>
      </div>
      <div className="order-items">
        {order?.lines.map((line, i) => (
          <div className="order-item" key={line.id}>
            <div className={`product-icon product-${i}`}>
              <Shirt size={27} strokeWidth={1.4} />
            </div>
            <div className="product-info">
              <strong>{line.name}</strong>
              <small>
                数量 {line.quantity} · 已申请 {line.requestedQuantity}
              </small>
              <span>{money(line.paidUnitCents)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="order-total">
        <span>订单实付</span>
        <strong>{order ? money(order.paidTotalCents) : '—'}</strong>
      </div>
    </section>
  );
}
function PolicyPanel({ evidence }: { evidence: PolicyEvidence[] }) {
  return (
    <section className="evidence-section">
      <div className="section-heading">
        <h3>
          <ShieldCheck size={16} />
          政策依据
        </h3>
        <span>{evidence.length} 条</span>
      </div>
      {!evidence.length ? (
        <div className="empty-evidence">
          <FileText size={21} />
          <p>
            助手查询政策后，
            <br />
            相关条款会展示在这里。
          </p>
        </div>
      ) : (
        evidence.map((evidence) => (
          <details className="evidence-card" key={evidence.citation}>
            <summary>
              <span>{evidence.title}</span>
              <ChevronDown size={14} />
            </summary>
            <p>{evidence.text}</p>
            <small>{evidence.citation}</small>
            <small>
              政策 {evidence.policyVersion} · 检索于 {time(evidence.retrievedAt)}
            </small>
          </details>
        ))
      )}
    </section>
  );
}
function TracePanel({
  records,
  trace,
  lastRun,
}: {
  records: RefObject<HTMLElement | null>;
  trace: ToolTrace[];
  lastRun: WebSnapshot['lastRun'];
}) {
  return (
    <section ref={records} className="trace-section">
      <div className="section-heading">
        <h3>
          <Clock3 size={16} />
          处理记录
        </h3>
        <span>{trace.filter((t) => t.type === 'tool_end').length} 次工具结果</span>
      </div>
      {trace.length ? (
        <ol className="trace-list">
          {trace.slice(-12).map((event, index) => (
            <li key={`${index}-${event.time}`}>
              <span
                className={`trace-dot ${event.type === 'tool_start' ? 'pending' : event.ok ? 'ok' : 'failed'}`}
              >
                {event.type === 'tool_end' && event.ok && <Check size={9} />}
              </span>
              <div>
                <strong>{toolLabel(event.tool)}</strong>
                <small>
                  {time(event.time)} ·{' '}
                  {event.type === 'tool_start' ? '开始' : event.ok ? '执行成功' : '执行失败'}
                </small>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty-trace">发送需求后，这里会显示实际处理过程。</p>
      )}
      {lastRun && (
        <div className="run-stats">
          本轮 {lastRun.modelCalls} 次模型调用 · {lastRun.toolCalls} 次工具调用
          <br />
          {lastRun.tokens.toLocaleString()} tokens · {statusLabels[lastRun.status]}
        </div>
      )}
    </section>
  );
}
