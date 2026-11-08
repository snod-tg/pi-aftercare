import type { MessageStatus } from '../../src/http/web-types';

const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
export const money = (cents: number) => currency.format(cents / 100);
export const time = (value: string) =>
  new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

const toolLabels = {
  get_order: '查询订单',
  get_aftercare_policy: '核对售后规则',
  search_aftercare_policy: '检索政策依据',
  list_variants: '查询尺码库存',
  quote_aftercare: '生成退换货方案',
  create_aftercare_request: '提交售后申请',
  get_request_status: '核对申请状态',
} as const;

export function toolLabel(name: string) {
  return Object.hasOwn(toolLabels, name) ? toolLabels[name as keyof typeof toolLabels] : name;
}

export const statusLabels = {
  completed: '本轮处理结束',
  interrupted: '服务中断，已恢复保存的记录',
  model_error: '模型响应异常，可重试',
  timeout: '处理超时，可重试',
  cancelled: '已停止处理',
  model_limit: '达到本轮模型调用上限',
  tool_limit: '达到本轮工具调用上限',
} satisfies Record<MessageStatus, string>;
