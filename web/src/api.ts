import type { WebSnapshot } from '../../src/http/web-types';
export type { WebSnapshot, QuoteView } from '../../src/http/web-types';
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer demo-alice' };
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error?.message ?? '服务连接失败，请稍后再试', response.status);
  return data as T;
}
export async function streamTurn(id: string, action: 'messages' | 'confirm', body: unknown, onEvent: (event: string, data: unknown) => void) {
  const response = await fetch(`/api/sessions/${id}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) {
    const data = await response.json();
    throw new ApiError(data.error?.message ?? '本轮请求失败', response.status);
  }
  if (!response.body) throw new Error('浏览器不支持流式响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let finished = false;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const event = packet.split('\n').find(line => line.startsWith('event: '))?.slice(7);
        const raw = packet.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
        if (event && raw) { onEvent(event, JSON.parse(raw)); if (event === 'result' || event === 'error') finished = true; }
      }
      if (chunk.done) break;
    }
    if (!finished) throw new Error('连接中断，正在恢复会话状态。已提交的申请仍可查询。');
  } finally { reader.releaseLock(); }
}
export const restoreSession = (id: string) => api<WebSnapshot>(`/sessions/${id}`);
