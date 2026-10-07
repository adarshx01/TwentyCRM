import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DbService } from '../database/db.service';
import { channelBindings, schedules } from '../database/schema';
import { IdentityService } from '../identity/identity.service';
import { QuotaService } from '../tenant/quota.service';
import { OutboundService } from '../outbound/outbound.service';
import { CRM_ADAPTER, ownerKeyOf, type CrmAdapter } from '../crm/crm-adapter.interface';
import { canUserAccess } from '../common/scope';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { buildDigestModel, isEmptyDigest, renderDigestCard, renderDigestText } from './digest-builder';
import type { ChannelName } from '../common/types';
import type { OutboundContent } from '../channels/channel.types';
import { M } from '../observability/metrics';
import { getLogger } from '../observability/logger';

export type DispatchOutcome = 'dispatched' | 'skipped_empty' | 'skipped_cutoff' | 'skipped_ineligible' | 'skipped_closed' | 'failed_no_destination';

/**
 * Builds and submits one morning digest (REM-01..REM-07).
 * Everything that matters is re-read at dispatch time: recipient eligibility, working
 * day and task state. The schedule row's unique key makes the whole operation idempotent.
 */
@Injectable()
export class DigestService {
  private readonly log = getLogger('digest');

  constructor(
    private readonly db: DbService,
    private readonly identity: IdentityService,
    private readonly quota: QuotaService,
    private readonly outbound: OutboundService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async close(tenantId: string, scheduleId: string, state: 'dispatched' | 'skipped' | 'failed', info?: Record<string, unknown>): Promise<void> {
    await this.db.tenantTx(tenantId, (tx) =>
      tx.update(schedules).set({ state, completedAt: new Date(), errorInfo: info ?? null }).where(and(eq(schedules.id, scheduleId), eq(schedules.type, 'digest'))),
    );
  }

  async dispatch(tenantId: string, scheduleId: string, now: Date = new Date()): Promise<DispatchOutcome> {
    const [sched] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(schedules).where(eq(schedules.id, scheduleId)));
    if (!sched || !['pending', 'claimed'].includes(sched.state)) return 'skipped_closed';

    const live = await this.identity.getActiveUser(tenantId, sched.userId);
    if (!live) {
      await this.close(tenantId, scheduleId, 'skipped', { reason: 'recipient_ineligible' });
      M.reminderResults().inc({ result: 'skipped_ineligible' });
      return 'skipped_ineligible';
    }
    const { tenant, user } = live;

    // Morning cutoff: never send an obsolete digest (REM-07).
    const cutoffMs = (tenant.settings.reminderCutoffMinutes ?? 120) * 60_000;
    if (now.getTime() > sched.nextRunUtc.getTime() + cutoffMs) {
      await this.close(tenantId, scheduleId, 'skipped', { reason: 'cutoff_exceeded' });
      M.reminderResults().inc({ result: 'skipped_cutoff' });
      return 'skipped_cutoff';
    }

    await this.quota.takeReminderSlot(tenant); // may defer (RetryLaterError) — not a failure

    // Re-read live task state (REM-06).
    const tz = sched.timezone;
    const endOfDay = DateTime.fromISO(sched.localDate, { zone: tz }).endOf('day').toUTC().toISO()!;
    const key = ownerKeyOf(user);
    const tasks = await this.crm.listTasks(tenant, { scope: { kind: 'owned', ownerKey: key }, status: 'open', dueBefore: endOfDay, maxRecords: 500 });
    const personIds = tasks.items.map((t) => t.personId).filter(Boolean) as string[];
    const people = new Map((await this.crm.getPeopleByIds(tenant, personIds)).filter((p) => canUserAccess(user, p)).map((p) => [p.id, p]));
    const companyIds = [...tasks.items.map((t) => t.companyId), ...[...people.values()].map((p) => p.companyId)].filter(Boolean) as string[];
    const companies = new Map((await this.crm.getCompaniesByIds(tenant, companyIds)).filter((c) => canUserAccess(user, c)).map((c) => [c.id, c]));

    const model = buildDigestModel({ tasks: tasks.items, people, companies, timezone: tz, localDate: sched.localDate, urlFor: (id) => this.crm.recordUrl(tenant, 'task', id) });
    if (isEmptyDigest(model)) {
      await this.close(tenantId, scheduleId, 'skipped', { reason: 'empty' });
      M.reminderResults().inc({ result: 'skipped_empty' });
      return 'skipped_empty';
    }

    // Destination: the employee's one preferred channel; no silent switching (REM-04, REM-07).
    const bindings = await this.db.tenantTx(tenantId, (tx) => tx.select().from(channelBindings).where(and(eq(channelBindings.userId, user.userId), eq(channelBindings.status, 'active'))));
    const wanted: ChannelName[] = user.dualDelivery ? (['whatsapp', 'teams'] as ChannelName[]) : [((user.preferredReminderChannel as ChannelName | undefined) ?? (bindings[0]?.channel as ChannelName | undefined))].filter(Boolean) as ChannelName[];
    const targets = wanted.filter((c) => bindings.some((b) => b.channel === c));
    if (!targets.length) {
      await this.close(tenantId, scheduleId, 'failed', { reason: 'no_destination' });
      M.reminderResults().inc({ result: 'failed_no_destination' });
      return 'failed_no_destination';
    }

    await this.db.tenantTx(tenantId, async (tx) => {
      for (const channel of targets) {
        const detail: OutboundContent = channel === 'teams'
          ? { kind: 'reply', ...renderDigestCard(model, user.displayName) }
          : { kind: 'reply', text: renderDigestText(model, user.displayName) };
        const binding = bindings.find((b) => b.channel === channel)!;
        const windowOpen = channel !== 'whatsapp' || (binding.lastInboundAt && now.getTime() - binding.lastInboundAt.getTime() < 24 * 3600_000);
        const wa = this.config.whatsapp;
        const count = model.meetings.length + model.dueToday.length + model.overdue.length + model.hidden;
        await this.outbound.enqueue({
          tenantId, userId: user.userId, channel, messageType: 'digest', idempotencyKey: `${sched.idempotencyKey}/${channel}`,
          // Template-first outside the 24h window; detail follows after the employee replies (WA-03).
          content: windowOpen || !wa ? detail : { kind: 'template', name: wa.templateName, params: [user.displayName, String(count)], fallbackText: 'Your daily task list is ready. Reply to see it.' },
          deferred: windowOpen || !wa ? undefined : detail,
        }, tx);
      }
      await tx.update(schedules).set({ state: 'dispatched', completedAt: new Date(), errorInfo: null }).where(eq(schedules.id, scheduleId));
    });
    M.reminderResults().inc({ result: 'dispatched' });
    M.reminderDelay().observe({}, Math.max(0, (now.getTime() - sched.nextRunUtc.getTime()) / 1000));
    return 'dispatched';
  }
}
