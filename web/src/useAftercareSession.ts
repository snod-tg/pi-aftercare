import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ServiceMeta,
  SessionSummary,
  ToolTrace,
  TurnCommand,
  WebSnapshot,
} from '../../src/http/web-types';
import { api, ApiError, restoreSession, streamTurn } from './api';

const sessionKey = 'pi-aftercare-session-v1';
const RECOVERY_INTERVAL_MS = 2000;
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export function useAftercareSession() {
  const [session, setSession] = useState<WebSnapshot | null>(null);
  const [meta, setMeta] = useState<ServiceMeta>();
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [liveTools, setLiveTools] = useState<ToolTrace[]>([]);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const initialized = useRef(false);
  const busy = working || Boolean(session?.busy);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory((await api<{ sessions: SessionSummary[] }>('/sessions')).sessions);
    } catch {
      /* The active conversation remains usable when history cannot be fetched. */
    }
  }, []);

  const accept = useCallback(
    (value: WebSnapshot) => {
      setSession(value);
      localStorage.setItem(sessionKey, value.id);
      void refreshHistory();
    },
    [refreshHistory],
  );

  const initialize = useCallback(async () => {
    if (locked.current) return;
    locked.current = true;
    setLoading(true);
    setError('');
    try {
      setMeta(await api<ServiceMeta>('/meta'));
      const id = localStorage.getItem(sessionKey);
      if (id) {
        try {
          accept(await restoreSession(id));
          return;
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          localStorage.removeItem(sessionKey);
        }
      }
      accept(await api<WebSnapshot>('/sessions', 'POST', {}));
    } catch (error) {
      setError(errorMessage(error, '连接失败'));
    } finally {
      locked.current = false;
      setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void initialize();
  }, [initialize]);

  const sessionId = session?.id;
  const sessionBusy = session?.busy;
  useEffect(() => {
    if (!sessionId || !sessionBusy || working) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await restoreSession(sessionId);
        if (disposed) return;
        setSession((current) => (current?.id === sessionId ? snapshot : current));
        if (!snapshot.busy) {
          void refreshHistory();
          return;
        }
      } catch {
        if (disposed) return;
        setError('无法恢复会话状态，请检查后台服务');
      }
      timer = setTimeout(poll, RECOVERY_INTERVAL_MS);
    };
    timer = setTimeout(poll, RECOVERY_INTERVAL_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, sessionBusy, working, refreshHistory]);

  async function switchSession(load: () => Promise<WebSnapshot>, fallback: string) {
    if (locked.current || busy || loading) return;
    locked.current = true;
    setLoading(true);
    setError('');
    try {
      accept(await load());
      setLiveText('');
      setLiveTools([]);
    } catch (error) {
      setError(errorMessage(error, fallback));
    } finally {
      locked.current = false;
      setLoading(false);
    }
  }

  async function runTurn(command: TurnCommand) {
    if (!sessionId || locked.current || busy) return false;
    locked.current = true;
    setWorking(true);
    setError('');
    setLiveText('');
    setLiveTools([]);
    let accepted = false;
    let hasResult = false;
    try {
      await streamTurn(sessionId, command, (event) => {
        switch (event.type) {
          case 'start': {
            accepted = true;
            const { message } = event.data;
            setSession((current) => {
              if (
                current?.id !== sessionId ||
                current.messages.some((item) => item.id === message.id)
              )
                return current;
              return { ...current, busy: true, messages: [...current.messages, message] };
            });
            break;
          }
          case 'trace': {
            const trace = event.data;
            if (trace.type === 'text') setLiveText((text) => text + (trace.text ?? ''));
            else {
              const { type, time, tool, ok } = trace;
              setLiveTools((items) => [
                ...items,
                { type, time, tool: tool ?? '', ...(ok === undefined ? {} : { ok }) },
              ]);
            }
            break;
          }
          case 'result':
            accept(event.data);
            hasResult = true;
            setLiveText('');
            setLiveTools([]);
            break;
          case 'error':
            setError(event.data.message);
            break;
        }
      });
    } catch (error) {
      setError(errorMessage(error, '连接中断，请重试'));
    } finally {
      if (!hasResult) {
        try {
          accept(await restoreSession(sessionId));
        } catch {
          /* Keep the last server state and the visible error. */
        }
      }
      setWorking(false);
      locked.current = false;
      setLiveText('');
      setLiveTools([]);
    }
    return accepted;
  }

  async function cancel() {
    if (!sessionId) return;
    try {
      await api(`/sessions/${sessionId}/cancel`, 'POST', {});
    } catch {
      setError('停止请求未送达，请检查后台连接');
    }
  }

  return {
    session,
    meta,
    history,
    loading,
    working,
    busy,
    error,
    liveText,
    liveTools,
    initialize,
    cancel,
    clearError: () => setError(''),
    newChat: () => switchSession(() => api<WebSnapshot>('/sessions', 'POST', {}), '创建会话失败'),
    openHistory: (id: string) =>
      id === sessionId
        ? Promise.resolve()
        : switchSession(() => restoreSession(id), '恢复会话失败'),
    sendMessage: (text: string) =>
      text.trim() ? runTurn({ kind: 'message', content: text.trim() }) : Promise.resolve(false),
    confirmQuote: (quoteId: string) => runTurn({ kind: 'confirm', quoteId }),
  };
}
