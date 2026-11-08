import { CheckCheck } from 'lucide-react';
import type { AftercareRequest } from '../../../src/domain/types';
import { money } from '../presentation';

export function ReceiptCard({ request }: { request: AftercareRequest }) {
  return (
    <div className="receipt">
      <div className="receipt-heading">
        <span>
          <CheckCheck size={20} />
        </span>
        <div>
          <strong>售后申请已创建</strong>
          <small>来自后台的申请回执</small>
        </div>
        <span className="receipt-status">等待寄回</span>
      </div>
      <div className="receipt-row">
        <span>申请编号</span>
        <code>{request.id}</code>
      </div>
      <div className="receipt-row">
        <span>预计退款</span>
        <strong>{money(request.refundCents)}</strong>
      </div>
      <p>请等待后续寄回指引。退款尚未开始，本演示不处理真实资金。</p>
    </div>
  );
}
