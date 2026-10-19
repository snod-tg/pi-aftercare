import 'dotenv/config';
import { createInterface } from 'node:readline';
import { defineTool, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { createConnectedModel, readModelConnection } from '../src/agent/model-connection.js';
import { createIsolatedToolSession } from '../src/agent/session.js';

const lines = createInterface({ input: process.stdin, terminal: false });
const emit = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
let session: AgentSession | undefined;
let active = false; let done = false; let actions = 0; let modelCalls = 0; let maxSteps = 30;
const pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();
let key = '';
const safeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '评测 worker 错误';
  return (key ? message.replaceAll(key, '[redacted]') : message).slice(0, 1000);
};
interface WireTool { type: string; function: { name: string; description: string; parameters: TSchema } }
async function init(message: { tools: WireTool[]; wiki: string; maxSteps: number }) {
  if (session || !Array.isArray(message.tools) || !Number.isSafeInteger(message.maxSteps) || message.maxSteps < 1 || message.maxSteps > 100) throw new Error('非法或重复 init');
  maxSteps = message.maxSteps;
  const connection = readModelConnection(); key = connection.apiKey;
  const { modelRuntime, model } = await createConnectedModel(connection);
  const names = new Set<string>();
  const tools = message.tools.map(tool => {
    const f = tool.function;
    if (tool.type !== 'function' || !f?.name || names.has(f.name) || !f.parameters || (f.parameters as { type?: unknown }).type !== 'object') throw new Error('无效的环境工具定义');
    names.add(f.name);
    return defineTool({ name: f.name, label: f.name, description: f.description, parameters: f.parameters, executionMode: 'sequential',
      execute: async (id, args, signal) => {
        if (done || ++actions > maxSteps) throw new Error('环境动作步数已达上限');
        const observation = await new Promise<string>((resolve, reject) => {
          const abort = () => { pending.delete(id); reject(new Error('环境动作已取消')); };
          pending.set(id, { resolve: value => { signal?.removeEventListener('abort', abort); resolve(value); }, reject });
          if (signal?.aborted) { abort(); return; }
          signal?.addEventListener('abort', abort, { once: true });
          emit({ type: 'action', id, action: { name: f.name, kwargs: args } });
        });
        return { content: [{ type: 'text' as const, text: observation }], details: {} };
      },
    });
  });
  ({ session } = await createIsolatedToolSession({ modelRuntime, model, tools, systemPrompt: message.wiki }));
  const original = session.agent.streamFunction;
  session.agent.streamFunction = (selected, context, options) => {
    if (done || ++modelCalls > maxSteps) throw new Error('模型请求次数已达上限');
    emit({ type: 'progress', event: 'model_request', stats: { modelCalls, toolCalls: actions } });
    return original(selected, context, { ...options, maxTokens: connection.maxOutputTokens, maxRetries: 0 });
  };
  emit({ type: 'ready' });
}
async function prompt(text: string) {
  if (!session || active || done || typeof text !== 'string' || !text.trim()) throw new Error('无法处理当前 prompt');
  active = true;
  let answer = ''; let error: string | undefined; let timedOut = false;
  const before = session.getSessionStats().tokens.total;
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      emit({ type: 'progress', event: 'model_response', stats: { modelCalls, stopReason: event.message.stopReason } });
      answer = event.message.content.filter(p => p.type === 'text').map(p => p.text).join('');
      if (['error', 'length'].includes(event.message.stopReason)) error = event.message.errorMessage ?? `模型输出终止：${event.message.stopReason}`;
    }
  });
  const timeout = Number(process.env.TAU_TURN_TIMEOUT_MS ?? '120000');
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000) throw new Error('非法 TAU_TURN_TIMEOUT_MS');
  const timer = setTimeout(() => { timedOut = true; session?.agent.abort(); }, timeout);
  try { await session.prompt(text, { expandPromptTemplates: false }); }
  catch (cause) { error = safeError(cause); }
  finally { clearTimeout(timer); unsubscribe(); active = false; }
  emit({ type: 'turn', text: answer, done, modelCalls, toolCalls: actions, tokens: session.getSessionStats().tokens.total - before, ...(timedOut ? { error: '模型轮次超时' } : error && !done ? { error: safeError(error) } : {}) });
}
lines.on('line', line => {
  void (async () => {
    const message = JSON.parse(line);
    if (message.type === 'init') await init(message);
    else if (message.type === 'prompt') await prompt(message.text);
    else if (message.type === 'observation') {
      const waiting = pending.get(message.id);
      if (!waiting) throw new Error('未知环境响应');
      pending.delete(message.id);
      done = Boolean(message.done);
      waiting.resolve(String(message.observation));
      if (done) session?.agent.abort();
    } else if (message.type === 'close') {
      session?.agent.abort();
      session?.dispose(); lines.close(); process.stdin.destroy();
    } else throw new Error('未知 worker 消息');
  })().catch(error => { emit({ type: 'error', error: safeError(error) }); });
});
lines.on('close', () => { session?.agent.abort(); session?.dispose(); });
