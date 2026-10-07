import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { enrichContext } from '../common/context/request-context';

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Either the pool or an open transaction. */
export type Executor = Database | Tx;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Database access with mandatory tenant scoping (TEN-03).
 *
 *  - tenantTx(): every statement in the callback runs under RLS for one tenant.
 *    `set_config(..., true)` is transaction-local, so the setting disappears at
 *    COMMIT/ROLLBACK and cannot leak into the next user of a pooled connection.
 *  - systemTx(): explicit cross-tenant access for tenant-resolution and
 *    schedulers. Callers must pass an audited reason (logged by the caller).
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly client: postgres.Sql;
  readonly db: Database;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = postgres(config.database.url, {
      max: config.database.poolMax,
      idle_timeout: 20,
      connect_timeout: 10,
      // PgBouncer transaction pooling cannot keep named prepared statements.
      prepare: false,
      onnotice: () => undefined,
    });
    this.db = drizzle(this.client, { schema });
  }

  async tenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) throw new Error('tenantTx requires a UUID tenant id');
    enrichContext({ tenantId });
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  }

  async systemTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.system', 'on', true)`);
      return fn(tx);
    });
  }

  /** pg-boss compatible executor bound to a transaction (enqueue atomically with state). */
  static bossExecutor(tx: Tx): { executeSql(text: string, values: any[]): Promise<{ rows: any[] }> } {
    return {
      async executeSql(text: string, values: any[]) {
        // pg (used by pg-boss) maps undefined → NULL and objects → JSON; postgres-js does neither for untyped params.
        const rows = await (tx as any).session.client.unsafe(text, values.map((v) => (v === undefined ? null : v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) && !Array.isArray(v) ? JSON.stringify(v) : v)));
        return { rows: Array.from(rows) };
      },
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.client`select 1`;
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
