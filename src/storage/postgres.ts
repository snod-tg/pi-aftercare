import pg from 'pg';
import type { PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { AftercareService } from '../domain/aftercare.js';
import type { AftercareBackend, SessionReadQuery } from '../domain/backend.js';
import { DomainError } from '../domain/errors.js';
import { createDemoState } from '../domain/seed.js';
import type { Actor, AftercareAction, CreateRequestInput, DemoState } from '../domain/types.js';

const maps = {
  order: 'orders',
  variant: 'variants',
  quote: 'quotes',
  confirmation: 'confirmations',
  request: 'requests',
  operation: 'operations',
} as const;
type RecordRow = { kind: string; id: string; body: unknown };
function rows(state: DemoState): RecordRow[] {
  return [
    { kind: 'policy', id: 'active', body: state.policy },
    ...Object.entries(maps).flatMap(([kind, name]) =>
      [...(state[name] as Map<string, unknown>)].map(([id, body]) => ({ kind, id, body })),
    ),
  ];
}
function decode(records: RecordRow[]): DemoState {
  const state = createDemoState();
  for (const name of Object.values(maps)) state[name].clear();
  const policy = records.find((row) => row.kind === 'policy');
  if (!policy) throw new Error('数据库缺少政策记录，请先运行 db:init');
  state.policy = policy.body as DemoState['policy'];
  for (const row of records) {
    const name = maps[row.kind as keyof typeof maps];
    if (name) (state[name] as Map<string, unknown>).set(row.id, row.body);
  }
  return state;
}
export interface PostgresOptions {
  connectionString: string;
  schema?: string;
  merchantId?: string;
  now?: () => Date;
  beforeCommit?: () => void | Promise<void>;
}

export class PostgresAftercareService implements AftercareBackend {
  readonly pool: pg.Pool;
  readonly schema: string;
  private readonly merchantId: string;
  constructor(private readonly options: PostgresOptions) {
    this.schema = options.schema ?? 'aftercare';
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(this.schema)) throw new Error('非法 DATABASE_SCHEMA');
    this.merchantId = options.merchantId ?? 'M-DEMO';
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: 8,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
    this.pool.on('error', () => {
      /* Individual calls report failures without exposing connection credentials. */
    });
  }
  private async transaction<T>(write: boolean, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let failed = false;
    try {
      await client.query(write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL search_path TO "${this.schema}", pg_catalog`);
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const result = await fn(client);
      if (write) await this.options.beforeCommit?.();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        failed = true;
      }
      throw error;
    } finally {
      client.release(failed);
    }
  }
  async migrate() {
    const sql = await readFile(
      new URL('../../migrations/001_aftercare.sql', import.meta.url),
      'utf8',
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `pi-aftercare-migration:${this.schema}`,
      ]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      await client.query(`SET LOCAL search_path TO "${this.schema}", pg_catalog`);
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async seed(state = createDemoState()) {
    for (const order of state.orders.values())
      if (order.merchantId !== this.merchantId) throw new Error('种子数据商家不匹配');
    // Never refresh dates, stock, or existing requests on a subsequent init.
    await this.transaction(true, async (client) => {
      const inserted = await client.query(
        'INSERT INTO tenants(merchant_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING merchant_id',
        [this.merchantId],
      );
      if (!inserted.rowCount) return;
      for (const row of rows(state))
        await client.query(
          'INSERT INTO resources(merchant_id,kind,id,body) VALUES($1,$2,$3,$4::jsonb)',
          [this.merchantId, row.kind, row.id, JSON.stringify(row.body)],
        );
    });
  }
  private assertMerchant(actor: Actor) {
    if (actor.merchantId !== this.merchantId)
      throw new DomainError('NOT_FOUND', '资源不存在或不属于当前商家', 404);
  }

  private async loadRecords(client: PoolClient, forUpdate: boolean) {
    const tenant = await client.query(
      `SELECT merchant_id FROM tenants WHERE merchant_id=$1${forUpdate ? ' FOR UPDATE' : ''}`,
      [this.merchantId],
    );
    if (!tenant.rowCount) throw new Error('数据库未初始化，请先运行 db:init');
    const result = await client.query<RecordRow>(
      'SELECT kind,id,body FROM resources WHERE merchant_id=$1 ORDER BY kind,id',
      [this.merchantId],
    );
    return result.rows;
  }

  private async read<T>(actor: Actor, operation: (service: AftercareService) => T): Promise<T> {
    this.assertMerchant(actor);
    return this.transaction(false, async (client) => {
      const records = await this.loadRecords(client, false);
      return operation(new AftercareService(decode(records), this.options.now));
    });
  }

  private async write<T>(actor: Actor, operation: (service: AftercareService) => T): Promise<T> {
    this.assertMerchant(actor);
    return this.transaction(true, async (client) => {
      const records = await this.loadRecords(client, true);
      const before = new Map(
        records.map((row) => [`${row.kind}:${row.id}`, JSON.stringify(row.body)]),
      );
      const state = decode(records);
      const result = operation(new AftercareService(state, this.options.now));
      await this.persistChanges(client, before, state);
      return result;
    });
  }

  private async persistChanges(
    client: PoolClient,
    before: ReadonlyMap<string, string>,
    state: DemoState,
  ) {
    for (const row of rows(state)) {
      const body = JSON.stringify(row.body);
      if (before.get(`${row.kind}:${row.id}`) === body) continue;
      await client.query(
        'INSERT INTO resources(merchant_id,kind,id,body) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(merchant_id,kind,id) DO UPDATE SET body=EXCLUDED.body',
        [this.merchantId, row.kind, row.id, body],
      );
    }
    await client.query('UPDATE tenants SET revision=revision+1 WHERE merchant_id=$1', [
      this.merchantId,
    ]);
  }

  getOrder(actor: Actor, orderId: string) {
    return this.read(actor, (service) => service.getOrder(actor, orderId));
  }
  getPolicy(actor: Actor, orderId: string) {
    return this.read(actor, (service) => service.getPolicy(actor, orderId));
  }
  listVariants(actor: Actor, orderId: string, lineId: string) {
    return this.read(actor, (service) => service.listVariants(actor, orderId, lineId));
  }
  listPendingQuotes(actor: Actor) {
    return this.read(actor, (service) => service.listPendingQuotes(actor));
  }
  quote(actor: Actor, orderId: string, actions: AftercareAction[]) {
    return this.write(actor, (service) => service.quote(actor, orderId, actions));
  }
  confirmQuote(actor: Actor, quoteId: string) {
    return this.write(actor, (service) => service.confirmQuote(actor, quoteId));
  }
  getRequest(actor: Actor, requestId: string) {
    return this.read(actor, (service) => service.getRequest(actor, requestId));
  }
  getOperation(actor: Actor, idempotencyKey: string) {
    return this.read(actor, (service) => service.getOperation(actor, idempotencyKey));
  }
  createRequest(actor: Actor, input: CreateRequestInput) {
    return this.write(actor, (service) => service.createRequest(actor, input));
  }
  readSessionData(actor: Actor, query: SessionReadQuery) {
    return this.read(actor, (service) => service.readSessionData(actor, query));
  }
  close() {
    return this.pool.end();
  }
}
