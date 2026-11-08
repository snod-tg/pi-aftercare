import { useEffect, useState } from 'react';
import { ArrowRight, Check, ChevronDown, Clock3, FileText } from 'lucide-react';
import type { QuoteView } from '../../../src/http/web-types';
import { money, time } from '../presentation';

export function QuoteCard({
  quote,
  busy,
  confirm,
}: {
  quote: QuoteView;
  busy: boolean;
  confirm: () => void;
}) {
  const expiresAt = Date.parse(quote.expiresAt);
  const [now, setNow] = useState(Date.now);
  const expired = now >= expiresAt;
  // The UI follows the displayed deadline; the server still authorizes confirmation.
  useEffect(() => {
    if (now >= expiresAt || !Number.isFinite(expiresAt)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt, now]);
  return (
    <div className="quote-card">
      <div className="quote-heading">
        <span>
          <FileText size={17} />
          请确认退换货方案 · {quote.orderId}
        </span>
        <span className="quote-tag">{expired ? '已过期' : '待你确认'}</span>
      </div>
      <div className="quote-lines">
        {quote.descriptions.map((description, i) => (
          <div key={i}>
            <Check size={14} />
            {description}
          </div>
        ))}
      </div>
      <div className="quote-refund">
        <span>预计退款</span>
        <strong>{money(quote.refundCents)}</strong>
      </div>
      <div className="quote-bottom">
        <small>
          <Clock3 size={12} />
          {expired ? '请让助手重新生成方案' : `有效至 ${time(quote.expiresAt)}`}
        </small>
        <button onClick={confirm} disabled={busy || expired}>
          确认并提交
          <ArrowRight size={15} />
        </button>
      </div>
      <details className="quote-reference">
        <summary>
          查看方案编号
          <ChevronDown size={12} />
        </summary>
        <code>{quote.id}</code>
        <span>政策版本：{quote.policyVersion}</span>
      </details>
    </div>
  );
}
