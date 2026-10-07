import { Controller, Get, Headers, Inject, Res, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { AdminOnly, Public } from '../common/decorators';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DbService } from '../database/db.service';
import { QueueService } from '../queue/queue.service';
import { LIMITER_BACKEND, type LimiterBackend } from '../ratelimit/limiter';
import { STORAGE, type StorageProvider } from '../media/storage';
import { M, metrics } from '../observability/metrics';

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

@Controller()
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly queue: QueueService,
    @Inject(LIMITER_BACKEND) private readonly limiter: LimiterBackend,
    @Inject(STORAGE) private readonly storage: StorageProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: the process is up. */
  @Public() @Get('health')
  live() { return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) }; }

  /** Readiness: dependencies needed to serve traffic. Redis is optional for correctness (limiter degrades closed). */
  @Public() @Get('health/ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const [database, queue, redis, storage] = await Promise.all([this.db.ping(), this.queue.ping(), this.limiter.ping(), this.storage.ping()]);
    const ok = database && queue;
    if (!ok) reply.status(503);
    return { status: ok ? 'ready' : 'unavailable', checks: { database, queue, redis, storage } };
  }

  /** Operator diagnostics (§11): queue age, failures, dead letters, scheduling lag, delivery and mailbox health. */
  @AdminOnly() @Get('health/detailed')
  async detailed() {
    const queues = await this.queue.stats();
    const one = async <T,>(q: ReturnType<typeof sql>) => (await this.db.systemTx((tx) => tx.execute(q)))[0] as unknown as T;
    const dead = await one<{ n: number }>(sql`select count(*)::int as n from dead_letters where resolved_at is null`);
    const sched = await one<{ lag: number | null; pending: number }>(sql`select coalesce(extract(epoch from (now() - min(next_run_utc)))::int, 0) as lag, count(*)::int as pending from schedules where state = 'pending' and next_run_utc <= now()`);
    const amb = await one<{ n: number }>(sql`select count(*)::int as n from delivery_state where status = 'ambiguous'`);
    const failedDel = await one<{ n: number }>(sql`select count(*)::int as n from delivery_state where status = 'failed' and created_at > now() - interval '1 day'`);
    const mbx = await this.db.systemTx((tx) => tx.execute(sql`select source_id, health, last_polled_at from mailbox_checkpoints where health <> 'ok'`));
    const review = await one<{ n: number }>(sql`select count(*)::int as n from intake_records where state = 'review'`);
    const pool = await this.db.client`select count(*)::int as n from pg_stat_activity where datname = current_database()`;
    return { queues, deadLettersOpen: dead.n, overdueSchedules: sched, ambiguousSends: amb.n, failedDeliveries24h: failedDel.n, unhealthyMailboxes: mbx, intakeReviewBacklog: review.n, dbConnections: pool[0].n, config: { appRole: this.config.app.role } };
  }

  /** Prometheus metrics. Authorized by METRICS_TOKEN or the admin key. */
  @Public() @Get('metrics')
  async metrics(@Headers('authorization') auth: string | undefined, @Headers('x-api-key') key: string | undefined, @Res() reply: FastifyReply) {
    const token = this.config.observability.metricsToken;
    const ok = (token && auth === `Bearer ${token}`) || (key && safeEq(key, this.config.security.adminApiKey));
    if (!ok) throw new UnauthorizedException();
    try { await this.queue.stats(); } catch { /* queue not started in this role */ }
    void M;
    reply.type('text/plain; version=0.0.4').send(metrics.render());
  }
}
