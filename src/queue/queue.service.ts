import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DelayedError, Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DbService, type Tx } from '../database/db.service';
import { deadLetters, queueOutbox } from '../database/schema';
import { currentContext, runWithContext } from '../common/context/request-context';
import { generateCorrelationId } from '../common/utils/crypto.util';
import { PermanentError, RetryLaterError, errorMessage } from '../common/errors';
import { getLogger } from '../observability/logger';
import { M } from '../observability/metrics';
import { QUEUES, QUEUE_DEFAULTS, type JobMeta, type JobPayload, type QueueName } from './queues';

export const MAX_DEFERRALS = 200;

/** Stable UUID from a string: the BullMQ job id for an idempotency key (BullMQ forbids ':' in custom ids). */
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
  /** Attempts already made before this one */
  retryCount: number;
  retryLimit: number;
  meta: JobMeta;
}

export type JobHandler<T> = (data: JobPayload<T>, job: JobInfo) => Promise<void>;
export type FinalFailureHook = (data: any, error: string, meta: JobMeta) => Promise<void>;

/**
 * Durable job queue on BullMQ (Redis) with a PostgreSQL transactional outbox.
 *
 *  - Enqueue = INSERT into `queue_outbox` inside the caller's transaction (atomic with the draft/operation
 *    write), then a relay publishes it to BullMQ. Job ids are derived from the idempotency key, so the
 *    at-least-once relay can never create two jobs. If Redis is unavailable, rows simply wait.
 *  - Redis holds no business truth: losing Redis loses only in-flight scheduling, which the journal, leases and
 *    outbox recover (jobs are re-published / retried idempotently).
 *  - Retries use BullMQ exponential backoff with jitter; deferrals (rate budget / concurrency) are moved to
 *    the delayed set without consuming an attempt; permanent errors fail fast; exhausted jobs are written to
 *    `dead_letters` and stay in BullMQ's failed set for inspection.
 *  - Worker crashes are recovered by BullMQ's stalled-job detection (lock expiry).
 */
@Injectable()
export class QueueService {
  private conn?: Redis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private relayTimer?: NodeJS.Timeout;
  private relaying?: Promise<number>;
  private stopped = true;
  private readonly log = getLogger('queue');
  private finalHooks = new Map<string, FinalFailureHook>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
  ) {}

  get started(): boolean {
    return !this.stopped;
  }

  /** Connect to Redis, create queue handles and start the outbox relay. `schedule` is accepted for call-site symmetry. */
  async start(_opts: { supervise?: boolean; schedule?: boolean } = {}): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.conn = new Redis(this.config.redis.url, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.conn.on('error', (e) => this.log.warn({ err: e.message }, 'queue redis error'));
    for (const name of Object.values(QUEUES)) {
      this.queues.set(name, new Queue(name, { connection: this.conn, prefix: this.config.queue.prefix }));
    }
    this.relayTimer = setInterval(() => void this.relay().catch((e) => this.log.warn({ err: errorMessage(e) }, 'outbox relay failed')), this.config.queue.outboxPollMs);
    this.relayTimer.unref();
    void this.relay().catch(() => undefined);
  }

  async stop(graceMs = 20_000, graceful = true): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.relayTimer) clearInterval(this.relayTimer);
    await this.relaying?.catch(() => undefined);
    // Graceful: stop fetching, let active jobs finish (bounded). Hard: simulate a crash — locks are NOT released.
    await Promise.race([
      Promise.all(this.workers.map((w) => w.close(!graceful))),
      new Promise((r) => setTimeout(r, graceful ? graceMs : 500)),
    ]);
    this.workers.length = 0;
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
    this.queues.clear();
    if (this.conn) { this.conn.disconnect(); this.conn = undefined; }
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

  private q(name: QueueName): Queue {
    const q = this.queues.get(name);
    if (!q) throw new Error('QueueService not started');
    return q;
  }

  // ── enqueue (outbox) ────────────────────────────────────────
  async send<T extends object>(queue: QueueName, data: T, meta: Partial<JobMeta> = {}, opts: SendOptions = {}, tx?: Tx): Promise<string | null> {
    if (this.stopped) throw new Error('QueueService not started');
    const m = this.buildMeta(meta);
    const jobId = m.idempotencyKey ? deterministicUuid(`${queue}:${m.idempotencyKey}`) : randomUUID();
    const row = { queue, jobId, tenantId: m.tenantId ?? null, payload: { ...data, _m: m } as Record<string, unknown>, delayMs: Math.max(0, Math.round((opts.startAfterSeconds ?? 0) * 1000)), priority: opts.priority ?? null };
    if (tx) {
      await tx.insert(queueOutbox).values(row);
      // The caller's transaction commits shortly; publish soon after (the poller is the safety net).
      setTimeout(() => void this.relay().catch(() => undefined), 40).unref();
    } else {
      await this.db.systemTx((t) => t.insert(queueOutbox).values(row));
      await this.relay().catch((e) => this.log.warn({ err: errorMessage(e) }, 'immediate relay failed; poller will retry'));
    }
    return jobId;
  }

  sendInTx<T extends object>(tx: Tx, queue: QueueName, data: T, meta: Partial<JobMeta> = {}, opts: SendOptions = {}): Promise<string | null> {
    return this.send(queue, data, meta, opts, tx);
  }

  /** Publish pending outbox rows to BullMQ. Safe to run from every process concurrently (SKIP LOCKED). */
  relay(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.relaying) return this.relaying;
    this.relaying = this.relayOnce().finally(() => { this.relaying = undefined; });
    return this.relaying;
  }

  private async relayOnce(): Promise<number> {
    let total = 0;
    for (let i = 0; i < 20 && !this.stopped; i++) {
      const n = await this.db.systemTx(async (tx) => {
        const rows = await tx.select().from(queueOutbox).orderBy(asc(queueOutbox.createdAt)).limit(200).for('update', { skipLocked: true });
        for (const r of rows) {
          const d = QUEUE_DEFAULTS[r.queue as QueueName];
          const mult = this.config.workers.retryDelayMultiplier;
          try {
            await this.q(r.queue as QueueName).add(r.queue, r.payload, {
              jobId: r.jobId, delay: r.delayMs || undefined, priority: r.priority ?? undefined,
              attempts: d.retryLimit + 1,
              backoff: d.retryBackoff ? { type: 'exponential', delay: Math.max(100, Math.round(d.retryDelay * 1000 * mult)), jitter: 0.3 } : { type: 'fixed', delay: Math.max(100, Math.round(d.retryDelay * 1000 * mult)) },
              removeOnComplete: { age: 7 * 86400, count: 200_000 },
              removeOnFail: { age: 14 * 86400 },
            });
          } catch (e) {
            await tx.update(queueOutbox).set({ attempts: sql`${queueOutbox.attempts} + 1` }).where(eq(queueOutbox.id, r.id));
            throw e; // Redis problem: roll back this batch's deletions; rows stay for the next poll
          }
          await tx.delete(queueOutbox).where(eq(queueOutbox.id, r.id));
        }
        return rows.length;
      });
      total += n;
      if (n < 200) break;
    }
    return total;
  }

  /** Register a repeatable producer (scheduler role). Idempotent: any number of processes may call it. */
  async cron(queue: QueueName, cron: string): Promise<void> {
    await this.q(queue).upsertJobScheduler(
      `cron-${queue}`,
      { pattern: cron },
      { name: queue, data: { _m: { correlationId: `cron-${queue}` } }, opts: { attempts: QUEUE_DEFAULTS[queue].retryLimit + 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 200 } } },
    );
  }

  onFinalFailure(queue: QueueName, hook: FinalFailureHook): void {
    this.finalHooks.set(queue, hook);
  }

  // ── consume ─────────────────────────────────────────────────
  /** One BullMQ worker with real concurrency (no polling slots to tune). */
  async work<T extends object>(queue: QueueName, concurrency: number, handler: JobHandler<T>): Promise<void> {
    if (!this.conn) throw new Error('QueueService not started');
    const worker = new Worker(queue, (job, token) => this.process(queue, job, token, handler as JobHandler<object>), {
      connection: this.conn, prefix: this.config.queue.prefix, concurrency,
      lockDuration: this.config.queue.lockDurationMs, stalledInterval: this.config.queue.stalledIntervalMs, maxStalledCount: 2,
    });
    worker.on('error', (e) => this.log.warn({ queue, err: e.message }, 'worker error'));
    worker.on('failed', (job, err) => { if (job) void this.onFailed(queue, job, err).catch((e) => this.log.error({ err: errorMessage(e) }, 'failure handling failed')); });
    this.workers.push(worker);
    await worker.waitUntilReady();
  }

  private async process(queue: QueueName, job: Job, token: string | undefined, handler: JobHandler<object>): Promise<void> {
    const payload = job.data as JobPayload<object>;
    const meta: JobMeta = payload._m ?? { correlationId: generateCorrelationId() };
    const retryLimit = (job.opts.attempts ?? 1) - 1;
    const info: JobInfo = { id: job.id ?? '', queue, retryCount: job.attemptsMade, retryLimit, meta };
    const end = M.jobDuration().startTimer({ queue });
    await runWithContext({ correlationId: meta.correlationId, tenantId: meta.tenantId, userId: meta.userId }, async () => {
      try {
        await handler(payload, info);
        M.jobResults().inc({ queue, result: 'ok' });
      } catch (e) {
        if (e instanceof RetryLaterError) {
          // Not a failure: park the job in the delayed set and keep its attempt budget (rate budget / lease busy).
          const deferrals = (meta.deferrals ?? 0) + 1;
          if (deferrals > MAX_DEFERRALS) { M.jobResults().inc({ queue, result: 'failed' }); throw new UnrecoverableError(`deferred too many times: ${e.reason}`); }
          await job.updateData({ ...payload, _m: { ...meta, deferrals } });
          await job.moveToDelayed(Date.now() + Math.max(1000, e.delayMs), token);
          M.jobResults().inc({ queue, result: 'deferred' });
          throw new DelayedError();
        }
        if (e instanceof PermanentError) {
          M.jobResults().inc({ queue, result: 'permanent' });
          throw new UnrecoverableError(`${e.code}: ${e.message}`);
        }
        if (!(e instanceof DelayedError)) {
          M.jobResults().inc({ queue, result: 'error' });
          this.log.warn({ queue, jobId: info.id, attempt: info.retryCount, err: errorMessage(e) }, 'job failed; will retry if attempts remain');
        }
        throw e;
      } finally {
        end();
      }
    });
  }

  private async onFailed(queue: QueueName, job: Job, err: Error): Promise<void> {
    const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!final || err instanceof DelayedError) return;
    const payload = job.data as JobPayload<object>;
    const meta = payload?._m ?? { correlationId: generateCorrelationId() };
    await runWithContext({ correlationId: meta.correlationId, tenantId: meta.tenantId }, async () => {
      await this.writeDeadLetter(queue, job.id ?? '', payload, err.message || 'retries exhausted', meta);
      await this.finalHooks.get(queue)?.(payload, err.message || 'retries exhausted', meta).catch((e) => this.log.error({ err: errorMessage(e) }, 'final-failure hook failed'));
    });
  }

  /** Operator-visible failure record (also used for permanent business failures that complete the job). */
  async writeDeadLetter(queue: string, jobId: string, payload: unknown, error: string, meta: JobMeta): Promise<void> {
    await this.db.systemTx(async (tx) => {
      const existing = await tx.select({ id: deadLetters.id }).from(deadLetters).where(and(eq(deadLetters.jobId, jobId), eq(deadLetters.queue, queue), isNull(deadLetters.resolvedAt)));
      if (existing.length) return;
      await tx.insert(deadLetters).values({ tenantId: meta.tenantId ?? null, queue, jobId, payload: redactPayload(payload), error: error.slice(0, 2000), correlationId: meta.correlationId });
    });
    M.deadLetters().inc({ queue });
  }

  // ── introspection ───────────────────────────────────────────
  async counts(queue: QueueName): Promise<{ waiting: number; active: number; delayed: number; failed: number; completed: number }> {
    const c = await this.q(queue).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized');
    return { waiting: (c.waiting ?? 0) + (c.prioritized ?? 0), active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, completed: c.completed ?? 0 };
  }

  /** Ids of registered repeatable producers (cron). */
  async schedulers(): Promise<string[]> {
    const out: string[] = [];
    for (const q of this.queues.values()) for (const s of await q.getJobSchedulers()) out.push(s.key ?? s.name ?? '');
    return out;
  }

  async outboxBacklog(): Promise<number> {
    const [r] = await this.db.systemTx((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(queueOutbox));
    return r?.n ?? 0;
  }

  /** Queue depth / oldest job age for health and alerts. */
  async stats(): Promise<Array<{ queue: string; queued: number; active: number; failed: number; oldestAgeSeconds: number }>> {
    const out: Array<{ queue: string; queued: number; active: number; failed: number; oldestAgeSeconds: number }> = [];
    for (const [name, q] of this.queues) {
      const c = await this.counts(name);
      const jobs = c.waiting ? await q.getJobs(['waiting'], 0, 4, true) : [];
      const oldest = jobs.length ? Math.max(0, Math.round((Date.now() - Math.min(...jobs.map((j) => j.timestamp))) / 1000)) : 0;
      out.push({ queue: name, queued: c.waiting + c.delayed, active: c.active, failed: c.failed, oldestAgeSeconds: oldest });
      M.queueDepth().set({ queue: name }, c.waiting + c.delayed);
      M.queueOldestAge().set({ queue: name }, oldest);
    }
    return out;
  }

  async ping(): Promise<boolean> {
    try {
      return !this.stopped && (await this.conn!.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}

/** Dead-letter payloads are operator-visible; drop content-bearing keys. */
function redactPayload(p: unknown): Record<string, unknown> {
  if (!p || typeof p !== 'object') return {};
  const drop = new Set(['text', 'body', 'transcript', 'raw', 'rawEmail', 'html']);
  return JSON.parse(JSON.stringify(p, (k, v) => (drop.has(k) ? '[redacted]' : v)));
}
