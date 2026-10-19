import pg from 'pg';
import { readFile } from 'node:fs/promises';
import type { Actor, AftercareRequest } from '../domain/types.js';
import type { ConversationCheckpoint } from '../agent/conversation.js';
import type { ChatMessage, PolicyEvidence, ToolTrace, WebSnapshot, SessionSummary } from '../http/web-types.js';
import { DomainError } from '../domain/errors.js';

export interface SavedSession {
  version: 1;
  id: string;
  actor: Actor;
  touched: number;
  busy: boolean;
  checkpoint: ConversationCheckpoint;
  messages: ChatMessage[];
  trace: ToolTrace[];
  evidence: PolicyEvidence[];
  requests: AftercareRequest[];
  lastRun?: WebSnapshot['lastRun'];
}
export interface SessionLease {
  value: SavedSession;
  save(value: SavedSession): Promise<void>;
  remove(): Promise<void>;
  release(): Promise<void>;
}
export interface SessionStore {
  readonly persistent: boolean;
  create(value: SavedSession): Promise<void>;
  load(actor: Actor, id: string): Promise<SavedSession>;
  list(actor: Actor): Promise<SessionSummary[]>;
  acquire(actor: Actor, id: string): Promise<SessionLease>;
}
const notFound = () => new DomainError('SESSION_NOT_FOUND', '会话不存在或不属于当前顾客', 404);
const busy = () => new DomainError('SESSION_BUSY', '上一轮仍在处理，请等待或停止后再试', 409);
const owns = (s: SavedSession, actor: Actor) => s.actor.merchantId === actor.merchantId && s.actor.customerId === actor.customerId;
const summary = (s: SavedSession): SessionSummary => ({ id: s.id,
  title: (s.messages.find(m => m.role === 'user')?.text ?? '新的对话').slice(0, 50),
  updatedAt: new Date(s.touched).toISOString(), messageCount: s.messages.length });

export class MemorySessionStore implements SessionStore {
  readonly persistent = false;
  private readonly values = new Map<string, SavedSession>();
  private readonly locks = new Set<string>();
  async create(value: SavedSession) { if (this.values.has(value.id)) throw new Error('会话已存在'); this.values.set(value.id, structuredClone(value)); }
  async load(actor: Actor, id: string) {
    const value = this.values.get(id);
    if (!value || !owns(value, actor)) throw notFound();
    return structuredClone(value);
  }
  async list(actor: Actor) { return [...this.values.values()].filter(s => owns(s, actor)).sort((a,b) => b.touched - a.touched).slice(0,50).map(summary); }
  async acquire(actor: Actor, id: string): Promise<SessionLease> {
    if (this.locks.has(id)) { await this.load(actor, id); throw busy(); }
    this.locks.add(id);
    try {
      const value = await this.load(actor, id);
      let released = false;
      return { value,
        save: async next => { if (released || next.id !== id || !owns(next, actor)) throw new Error('非法会话写入'); this.values.set(id, structuredClone(next)); },
        remove: async () => { if (released) throw new Error('会话锁已释放'); this.values.delete(id); },
        release: async () => { released = true; this.locks.delete(id); },
      };
    } catch (error) { this.locks.delete(id); throw error; }
  }
}

export class PostgresSessionStore implements SessionStore {
  readonly persistent = true;
  readonly schema: string;
  private readonly table: string;
  private readonly ready: Promise<void>;
  constructor(private readonly pool: pg.Pool, schema = 'aftercare') {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('非法 DATABASE_SCHEMA');
    this.schema = schema; this.table = `"${schema}".agent_sessions`;
    this.ready = this.migrate();
  }
  async migrate() {
    const sql = await readFile(new URL('../../migrations/002_sessions.sql', import.meta.url), 'utf8');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pi-aftercare-sessions-migration:${this.schema}`]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      await client.query(`SET LOCAL search_path TO "${this.schema}", pg_catalog`);
      await client.query(sql); await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async initialize() { await this.ready; }
  async create(value: SavedSession) {
    await this.ready;
    await this.pool.query(`INSERT INTO ${this.table}(id,merchant_id,customer_id,body) VALUES($1,$2,$3,$4::jsonb)`, [value.id,value.actor.merchantId,value.actor.customerId,JSON.stringify(value)]);
  }
  async load(actor: Actor, id: string) {
    await this.ready;
    const result = await this.pool.query<{body: SavedSession}>(`SELECT body FROM ${this.table} WHERE id=$1 AND merchant_id=$2 AND customer_id=$3`, [id,actor.merchantId,actor.customerId]);
    if (!result.rows[0]) throw notFound();
    return result.rows[0].body;
  }
  async list(actor: Actor) {
    await this.ready;
    const rows = await this.pool.query<{body: SavedSession}>(`SELECT body FROM ${this.table} WHERE merchant_id=$1 AND customer_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 50`, [actor.merchantId,actor.customerId]);
    return rows.rows.map(row => summary(row.body));
  }
  async acquire(actor: Actor, id: string): Promise<SessionLease> {
    await this.ready;
    // A dedicated connection holds a session-level lock, without a long transaction.
    // Releasing a process/connection releases the lock so an interrupted turn is recoverable.
    const client = await this.pool.connect();
    const lock = `pi-aftercare-session:${this.schema}:${id}`;
    let locked = false;
    const release = async () => {
      let failed = false;
      try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]); }
      catch { failed = true; }
      client.release(failed);
    };
    try {
      const owned = await client.query<{body: SavedSession}>(`SELECT body FROM ${this.table} WHERE id=$1 AND merchant_id=$2 AND customer_id=$3`, [id,actor.merchantId,actor.customerId]);
      if (!owned.rows[0]) throw notFound();
      locked = (await client.query<{ok:boolean}>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok', [lock])).rows[0]!.ok;
      if (!locked) throw busy();
      // Re-read after locking; another worker could have completed since the owner check.
      const result = await client.query<{body: SavedSession}>(`SELECT body FROM ${this.table} WHERE id=$1 AND merchant_id=$2 AND customer_id=$3`, [id,actor.merchantId,actor.customerId]);
      if (!result.rows[0]) throw notFound();
      let released = false;
      let queue: Promise<unknown> = Promise.resolve();
      return { value: result.rows[0].body,
        save: next => {
          if (released || next.id !== id || !owns(next,actor)) return Promise.reject(new Error('非法会话写入'));
          const body = JSON.stringify(next);
          const pending = queue.then(async () => {
            await client.query(`UPDATE ${this.table} SET body=$4::jsonb,updated_at=now() WHERE id=$1 AND merchant_id=$2 AND customer_id=$3`, [id,actor.merchantId,actor.customerId,body]);
          });
          queue = pending; return pending;
        },
        remove: async () => {
          await queue;
          await client.query(`DELETE FROM ${this.table} WHERE id=$1 AND merchant_id=$2 AND customer_id=$3`, [id,actor.merchantId,actor.customerId]);
        },
        release: async () => { if (released) return; released = true; try { await queue; } finally { await release(); } },
      };
    } catch (error) { await release(); throw error; }
  }
}
