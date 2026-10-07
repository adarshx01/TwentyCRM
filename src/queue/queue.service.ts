import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import PgBoss from 'pg-boss';
import postgres from 'postgres';
import { and, eq, isNull } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DbService, type Tx } from '../database/db.service';
import { deadLetters } from '../database/schema';
import { currentContext } from '../common/context/request-context';
import { generateCorrelationId } from '../common/utils/crypto.util';
import { PermanentError, RetryLaterError, errorMessage } from '../common/errors';
import { runWithContext } from '../common/context/request-context';
import { getLogger } from '../observability/logger';
import { M } from '../observability/metrics';
import { QUEUES, QUEUE_DEFAULTS, WORK_BATCH, dlqName, type JobMeta, type JobPayload, type QueueName } from './queues';

export const MAX_DEFERRALS = 200;

export function deterministicUuid(input: string): string {
  const h = createHash('sha256').update(input).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface SendOptions {
  startAfterSeconds?: number;
  priority?: number;
}

export interface JobInfo {
  id: string;
  queue: string;
  retryCount: number;
  retryLimit: number;
  meta: JobMeta;
}

export type JobHandler<T> = (data: JobPayload<T>, job: JobInfo) => Promise<void>;
export type FinalFailureHook = (data: any, error: string, meta: JobMeta) => Promise<void>;

/**
 * pg-boss wrapper (durable Postgres-backed queue).
 *
 *  - Jobs carry tenant, user and correlation IDs.
 *  - Enqueue can join the caller's DB transaction (sendInTx) so "state saved"
 *    and "job queued" are atomic.
 *  - Job IDs are derived from an idempotency key, so a repeated enqueue of the
 *    same business event creates one job.
 */
@Injectable()
export class QueueService {
  private boss?: PgBoss;
  private readonly log = getLogger('queue');
  private finalHooks = new Map<string, FinalFailureHook>();
  private workerIds: string[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly dbService: DbService,
  ) {}

  /** Start pg-boss. `supervise`/`schedule` only on worker/scheduler processes. */
  async start(opts: { supervise?: boolean; schedule?: boolean } = {}): Promise<void> {
    if (this.boss) return;
    // Several processes (api, worker, scheduler, rolling replicas) start at once. pg-boss schema migration and
    // queue DDL must not interleave (deadlocks), so startup is serialized with a session advisory lock
    // taken on a direct (non-pooled) connection.
    const lock = postgres(this.config.database.queueUrl ?? this.config.database.url, { max: 1, onnotice: () => undefined });
    try {
      await lock`select pg_advisory_lock(727275)`;
      const boss = new PgBoss({
        connectionString: this.config.database.queueUrl ?? this.config.database.url,
        max: this.config.database.queuePoolMax,
        application_name: 'crm-bee-queue',
        supervise: opts.supervise ?? false,
        schedule: opts.schedule ?? false,
        migrate: true,
      });
      boss.on('error', (e) => this.log.error({ err: e.message }, 'pg-boss error'));
      await boss.start();
      for (const name of Object.values(QUEUES)) {
        const d = QUEUE_DEFAULTS[name];
        await boss.createQueue(dlqName(name), { name: dlqName(name), retentionDays: 14 });
        await boss.createQueue(name, { name, ...d, retryDelay: Math.max(1, Math.round(d.retryDelay * this.config.workers.retryDelayMultiplier)), deadLetter: dlqName(name), retentionDays: 7 });
      }
      this.boss = boss;
    } finally {
      await lock`select pg_advisory_unlock(727275)`.catch(() => undefined);
      await lock.end({ timeout: 2 });
    }
  }

  async stop(graceMs = 20_000, graceful = true): Promise<void> {
    if (!this.boss) return;
    await this.boss.stop({ graceful, timeout: graceMs, wait: true });
    this.boss = undefined;
  }

  private get b(): PgBoss {
    if (!this.boss) throw new Error('QueueService not started');
    return this.boss;
  }

  get started(): boolean {
    return !!this.boss;
  }

  buildMeta(partial: Partial<JobMeta> = {}): JobMeta {
    const ctx = currentContext();
    return {
      correlationId: partial.correlationId ?? ctx?.correlationId ?? generateCorrelationId(),
      tenantId: partial.tenantId ?? ctx?.tenantId,
      userId: partial.userId ?? ctx?.userId,
      idempotencyKey: partial.idempotencyKey,
      deferrals: partial.deferrals,
    };
  }

  async send<T extends object>(queue: QueueName, data: T, meta: Partial<JobMeta> = {}, opts: SendOptions = {}, tx?: Tx): Promise<string | null> {
    const m = this.buildMeta(meta);
    const payload: JobPayload<T> = { ...data, _m: m };
    // pg-boss validates keys that are present, so only include options that are actually set.
    const sendOpts: PgBoss.SendOptions = {
      ...(opts.startAfterSeconds && opts.startAfterSeconds > 0 ? { startAfter: opts.startAfterSeconds } : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(m.idempotencyKey ? { id: deterministicUuid(`${queue}:${m.idempotencyKey}`) } : {}),
      ...(tx ? { db: DbService.bossExecutor(tx) } : {}),
    };
    return this.b.send(queue, payload as object, sendOpts);
  }

  sendInTx<T extends object>(tx: Tx, queue: QueueName, data: T, meta: Partial<JobMeta> = {}, opts: SendOptions = {}): Promise<string | null> {
    return this.send(queue, data, meta, opts, tx);
  }

  /** Register a cron schedule (scheduler role only). */
  async cron(queue: QueueName, cron: string): Promise<void> {
    await this.b.schedule(queue, cron, { _m: { correlationId: `cron-${queue}` } } as object);
  }

  onFinalFailure(queue: QueueName, hook: FinalFailureHook): void {
    this.finalHooks.set(queue, hook);
  }

  /**
   * Register `concurrency` independent pollers for a queue. Each processes one job
   * at a time, so a slow job never blocks the other slots (no head-of-line batch waits).
   */
  async work<T extends object>(queue: QueueName, concurrency: number, handler: JobHandler<T>): Promise<void> {
    const batch = WORK_BATCH[queue] ?? 1;
    for (let i = 0; i < concurrency; i++) {
      const id = await this.b.work<JobPayload<T>>(
        queue,
        { batchSize: batch, pollingIntervalSeconds: this.config.workers.pollIntervalSeconds, includeMetadata: true },
        async (jobs) => {
          const list = jobs as any[];
          if (list.length === 1) return this.runJob(queue, list[0], handler);
          // Run the batch concurrently; fail only the jobs that failed (the rest complete).
          const results = await Promise.allSettled(list.map((j) => this.runJob(queue, j, handler)));
          await Promise.all(results.map(async (r, idx) => {
            if (r.status === 'rejected') await this.b.fail(queue, list[idx].id, { message: errorMessage(r.reason).slice(0, 500) }).catch(() => undefined);
          }));
        },
      );
      this.workerIds.push(id);
    }
    // One dead-letter recorder per queue is enough.
    const dlq = await this.b.work<JobPayload<T>>(dlqName(queue), { batchSize: 5, pollingIntervalSeconds: 5 }, async (jobs) => {
      for (const job of jobs) await this.recordDeadLetter(queue, job as any);
    });
    this.workerIds.push(dlq);
  }

  private async runJob<T extends object>(queue: QueueName, job: any, handler: JobHandler<T>): Promise<void> {
    const payload = job.data as JobPayload<T>;
    const meta: JobMeta = payload._m ?? { correlationId: generateCorrelationId() };
    const info: JobInfo = { id: job.id, queue, retryCount: job.retryCount ?? 0, retryLimit: job.retryLimit ?? 0, meta };
    const end = M.jobDuration().startTimer({ queue });
    await runWithContext({ correlationId: meta.correlationId, tenantId: meta.tenantId, userId: meta.userId }, async () => {
      try {
        await handler(payload, info);
        M.jobResults().inc({ queue, result: 'ok' });
      } catch (e) {
        if (e instanceof RetryLaterError) {
          const deferrals = (meta.deferrals ?? 0) + 1;
          if (deferrals > MAX_DEFERRALS) {
            M.jobResults().inc({ queue, result: 'failed' });
            throw new Error(`deferred too many times: ${e.reason}`);
          }
          // Re-enqueue later; completing this job means the deferral is not a failure.
          const { _m, ...rest } = payload as any;
          await this.send(queue, rest, { ...meta, deferrals, idempotencyKey: meta.idempotencyKey ? `${meta.idempotencyKey}#d${deferrals}` : undefined }, { startAfterSeconds: Math.max(1, Math.ceil(e.delayMs / 1000)) });
          M.jobResults().inc({ queue, result: 'deferred' });
          return;
        }
        if (e instanceof PermanentError) {
          M.jobResults().inc({ queue, result: 'permanent' });
          this.log.error({ queue, jobId: info.id, code: e.code, err: e.message }, 'job failed permanently');
          await this.writeDeadLetter(queue, info.id, payload, e.message, meta);
          await this.finalHooks.get(queue)?.(payload, e.message, meta).catch(() => undefined);
          return;
        }
        M.jobResults().inc({ queue, result: 'error' });
        this.log.warn({ queue, jobId: info.id, attempt: info.retryCount, err: errorMessage(e) }, 'job failed; will retry if attempts remain');
        throw e;
      } finally {
        end();
      }
    });
  }

  private async recordDeadLetter<T extends object>(queue: QueueName, job: any): Promise<void> {
    const payload = job.data as JobPayload<T>;
    const meta = payload?._m ?? { correlationId: generateCorrelationId() };
    await runWithContext({ correlationId: meta.correlationId, tenantId: meta.tenantId }, async () => {
      await this.writeDeadLetter(queue, job.id, payload, 'retries exhausted', meta);
      await this.finalHooks.get(queue)?.(payload, 'retries exhausted', meta).catch((e) => this.log.error({ err: errorMessage(e) }, 'final-failure hook failed'));
    });
  }

  /** Operator-visible failure record (also used for permanent business failures that complete the job). */
  async writeDeadLetter(queue: string, jobId: string, payload: unknown, error: string, meta: JobMeta): Promise<void> {
    await this.dbService.systemTx(async (tx) => {
      const existing = await tx.select({ id: deadLetters.id }).from(deadLetters).where(and(eq(deadLetters.jobId, jobId), eq(deadLetters.queue, queue), isNull(deadLetters.resolvedAt)));
      if (existing.length) return;
      await tx.insert(deadLetters).values({ tenantId: meta.tenantId ?? null, queue, jobId, payload: redactPayload(payload), error: error.slice(0, 2000), correlationId: meta.correlationId });
    });
    M.deadLetters().inc({ queue });
  }

  /** Queue depth / oldest job age for health and alerts (SEC operational readiness). */
  async stats(): Promise<Array<{ queue: string; queued: number; active: number; failed: number; oldestAgeSeconds: number }>> {
    const rows = await this.dbService.client`
      select name as queue,
             count(*) filter (where state in ('created','retry'))::int as queued,
             count(*) filter (where state = 'active')::int as active,
             count(*) filter (where state = 'failed')::int as failed,
             coalesce(extract(epoch from (now() - min(created_on) filter (where state in ('created','retry')))), 0)::int as oldest
        from pgboss.job where name not like '%-dlq' group by name`;
    const out = rows.map((r) => ({ queue: r.queue as string, queued: r.queued as number, active: r.active as number, failed: r.failed as number, oldestAgeSeconds: r.oldest as number }));
    for (const r of out) {
      M.queueDepth().set({ queue: r.queue }, r.queued);
      M.queueOldestAge().set({ queue: r.queue }, r.oldestAgeSeconds);
    }
    return out;
  }

  async ping(): Promise<boolean> {
    try {
      await this.dbService.client`select 1 from pgboss.version limit 1`;
      return this.started;
    } catch {
      return false;
    }
  }
}

/** Dead-letter payloads are operator-visible; drop content-bearing keys. */
function redactPayload(p: unknown): unknown {
  if (!p || typeof p !== 'object') return p;
  const drop = new Set(['text', 'body', 'transcript', 'raw', 'rawEmail', 'html']);
  return JSON.parse(JSON.stringify(p, (k, v) => (drop.has(k) ? '[redacted]' : v)));
}
