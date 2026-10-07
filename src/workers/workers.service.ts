import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { QueueService } from '../queue/queue.service';
import { QUEUES, type AiExtractionJob, type CrmWriteJob, type EmailIntakeJob, type InboundEventJob, type MailboxPollJob, type OutboundJob, type ReconcileJob, type ReminderJob } from '../queue/queues';
import { InboundService } from '../webhooks/inbound.service';
import { ConversationService } from '../conversation/conversation.service';
import { OperationJournal } from '../crm/operations/operation-journal.service';
import { OutboundService } from '../outbound/outbound.service';
import { DigestService } from '../reminders/digest.service';
import { SchedulerService } from '../reminders/scheduler.service';
import { SchedulePlanner } from '../reminders/schedule-planner.service';
import { ReconciliationService } from '../crm/reconciliation.service';
import { IntakeService } from '../intake/intake.service';
import { MailboxPoller } from '../intake/mailbox.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { TenantService } from '../tenant/tenant.service';
import { DbService } from '../database/db.service';
import { intakeSources, schedules } from '../database/schema';
import { and, eq } from 'drizzle-orm';
import { PermanentError } from '../common/errors';
import { getLogger } from '../observability/logger';

/**
 * Registers queue consumers per process role. Pools are separate so each scales on its own:
 *   worker:    inbound-event, ai-extraction, crm-write, outbound-msg, reminder, email-intake, mailbox-poll, reconciliation
 *   scheduler: cron producers (schedule-tick, planner, maintenance, fan-outs) — exactly one instance fires each cron
 * Concurrency per pool comes from configuration (see docs/operations.md for sizing).
 */
@Injectable()
export class WorkersService {
  private readonly log = getLogger('workers');
  private readonly workerId = `${process.env.HOSTNAME ?? 'proc'}:${process.pid}:${randomUUID().slice(0, 6)}`;

  constructor(
    private readonly queue: QueueService,
    private readonly inbound: InboundService,
    private readonly conversation: ConversationService,
    private readonly journal: OperationJournal,
    private readonly outbound: OutboundService,
    private readonly digest: DigestService,
    private readonly scheduler: SchedulerService,
    private readonly planner: SchedulePlanner,
    private readonly reconcile: ReconciliationService,
    private readonly intake: IntakeService,
    private readonly mailbox: MailboxPoller,
    private readonly maintenance: MaintenanceService,
    private readonly tenants: TenantService,
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async startWorkers(): Promise<void> {
    const c = this.config.workers;
    const q = this.queue;

    await q.work<InboundEventJob>(QUEUES.INBOUND, c.aiConcurrency, async (job) => {
      const loaded = await this.inbound.load(job.eventId);
      if (!loaded || loaded.processed) return;
      await this.conversation.handleEvent(loaded.event);
      await this.inbound.markProcessed(job.eventId);
    });

    await q.work<AiExtractionJob>(QUEUES.AI_EXTRACTION, c.aiConcurrency, async (job) => {
      const { tenantId, userId } = job._m;
      if (!tenantId || !userId) throw new PermanentError('job without tenant/user');
      await this.conversation.processMedia(tenantId, userId, job);
    });
    q.onFinalFailure(QUEUES.AI_EXTRACTION, async (job: AiExtractionJob & { _m: { tenantId?: string; userId?: string } }) => {
      if (job._m.tenantId && job._m.userId) await this.conversation.onAiFinalFailure(job._m.tenantId, job._m.userId, job);
    });

    await q.work<CrmWriteJob>(QUEUES.CRM_WRITE, c.crmConcurrency, async (job, info) => {
      const tenantId = job._m.tenantId;
      if (!tenantId) throw new PermanentError('job without tenant');
      try {
        const outcome = await this.journal.execute(tenantId, job.operationId, this.workerId);
        await this.conversation.notifyOutcome(outcome);
        // Partial/failed business operations need an operator replay path (runbook): surface them as dead letters.
        if (outcome.status === 'needs_repair' || outcome.status === 'failed') await this.queue.writeDeadLetter(QUEUES.CRM_WRITE, info.id, { operationId: job.operationId }, outcome.reason, job._m);
        if (outcome.status !== 'noop' && outcome.op) await this.intake.onOperationFinished(outcome.op as any);
      } catch (e) {
        // After the first transient failure tell the employee what is saved vs retrying (CAP-08).
        if (info.retryCount >= 1) {
          const op = await this.journal.get(tenantId, job.operationId);
          if (op && op.state === 'in_progress') await this.conversation.notifyProgress(tenantId, op).catch(() => undefined);
        }
        throw e;
      }
    });
    q.onFinalFailure(QUEUES.CRM_WRITE, async (job: CrmWriteJob & { _m: { tenantId?: string } }, error) => {
      if (!job._m.tenantId) return;
      const op = await this.journal.markNeedsRepair(job._m.tenantId, job.operationId, error);
      if (op) {
        await this.conversation.notifyOutcome({ status: op.state === 'needs_repair' ? 'needs_repair' : 'failed', op, reason: error } as any);
        await this.intake.onOperationFinished(op as any);
      }
    });

    await q.work<OutboundJob>(QUEUES.OUTBOUND, c.outboundConcurrency, async (job) => {
      if (!job._m.tenantId) throw new PermanentError('job without tenant');
      await this.outbound.deliver(job._m.tenantId, job.deliveryId);
    });

    await q.work<ReminderJob>(QUEUES.REMINDER, c.reminderConcurrency, async (job) => {
      if (!job._m.tenantId) throw new PermanentError('job without tenant');
      await this.digest.dispatch(job._m.tenantId, job.scheduleId);
    });
    q.onFinalFailure(QUEUES.REMINDER, async (job: ReminderJob & { _m: { tenantId?: string } }, error) => {
      if (!job._m.tenantId) return;
      await this.db.tenantTx(job._m.tenantId, (tx) => tx.update(schedules).set({ state: 'failed', completedAt: new Date(), errorInfo: { reason: error } }).where(and(eq(schedules.id, job.scheduleId), eq(schedules.state, 'claimed'))));
    });

    await q.work<EmailIntakeJob>(QUEUES.EMAIL_INTAKE, c.intakeConcurrency, async (job) => {
      if (!job._m.tenantId) throw new PermanentError('job without tenant');
      await this.intake.process(job._m.tenantId, job.recordId);
    });

    await q.work<MailboxPollJob>(QUEUES.MAILBOX_POLL, 2, async (job) => { await this.mailbox.poll(job.sourceId); });
    await q.work<ReconcileJob>(QUEUES.RECONCILIATION, 2, async (job) => {
      await this.reconcile.run(job.tenantId);
      await this.intake.pollTwentyReviews(job.tenantId);
    });
    this.log.info({ workerId: this.workerId, concurrency: c }, 'workers started');
  }

  /** Cron producers: run on the scheduler process only. */
  async startScheduler(): Promise<void> {
    const q = this.queue;
    await q.work<Record<string, never>>(QUEUES.SCHEDULE_TICK, 1, async () => { await this.scheduler.tick(this.workerId); });
    await q.work<Record<string, never>>(QUEUES.PLANNER, 1, async () => { await this.planner.planAll(); });
    await q.work<Record<string, never>>(QUEUES.MAINT_FREQUENT, 1, async () => { await this.maintenance.frequent(); });
    await q.work<Record<string, never>>(QUEUES.MAINT_HOURLY, 1, async () => { await this.maintenance.hourly(); });
    await q.work<Record<string, never>>(QUEUES.MAINT_DAILY, 1, async () => { await this.maintenance.daily(); });
    // Fan-out jobs: one reconciliation / mailbox poll per tenant/source, executed by the worker pool.
    await q.work<Record<string, never>>(QUEUES.FANOUT_RECONCILE, 1, async () => {
      for (const tenantId of await this.tenants.listActiveIds()) await q.send(QUEUES.RECONCILIATION, { tenantId } satisfies ReconcileJob, { tenantId, idempotencyKey: `recon:${tenantId}:${Math.floor(Date.now() / 300_000)}` });
    });
    await q.work<Record<string, never>>(QUEUES.FANOUT_MAILBOX, 1, async () => {
      const sources = await this.db.systemTx((tx) => tx.select().from(intakeSources).where(eq(intakeSources.type, 'mailbox_poll')));
      for (const s of sources.filter((x) => x.status === 'active' && x.mailbox)) await q.send(QUEUES.MAILBOX_POLL, { sourceId: s.id } satisfies MailboxPollJob, { tenantId: s.tenantId, idempotencyKey: `mbx:${s.id}:${Math.floor(Date.now() / 60_000)}` });
    });

    await q.cron(QUEUES.SCHEDULE_TICK, '* * * * *');
    await q.cron(QUEUES.PLANNER, '7 * * * *');
    await q.cron(QUEUES.MAINT_FREQUENT, '* * * * *');
    await q.cron(QUEUES.MAINT_HOURLY, '17 * * * *');
    await q.cron(QUEUES.MAINT_DAILY, '43 3 * * *');
    await q.cron(QUEUES.FANOUT_RECONCILE, '*/5 * * * *');
    await q.cron(QUEUES.FANOUT_MAILBOX, '* * * * *');
    this.log.info('scheduler started');
  }
}
