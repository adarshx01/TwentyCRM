import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { crmIndex, reconciliationState, stageHistory } from '../database/schema';
import { TenantService } from '../tenant/tenant.service';
import { SchedulePlanner } from '../reminders/schedule-planner.service';
import { CRM_ADAPTER, type CrmAdapter } from './crm-adapter.interface';
import { IdentityService } from '../identity/identity.service';
import { getLogger } from '../observability/logger';
import { errorMessage } from '../common/errors';

const OVERLAP_MS = 2 * 60_000;

/**
 * Periodic reconciliation (SYNC-02, SYNC-03): recovers native Twenty UI edits and missed
 * change events. It records stage transitions (won/lost dates for reporting) and re-schedules
 * digests when task dates change. The `crm_index` holds only operational facts — it is not a
 * copy of the pipeline (SYNC-01). Re-fetching is always from Twenty (authoritative).
 */
@Injectable()
export class ReconciliationService {
  private readonly log = getLogger('reconciliation');

  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantService,
    private readonly planner: SchedulePlanner,
    private readonly identity: IdentityService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
  ) {}

  async run(tenantId: string, now: Date = new Date()): Promise<{ opportunities: number; tasks: number; stageChanges: number }> {
    const tenant = await this.tenants.getContext(tenantId);
    const cp = async (entity: string) => (await this.db.tenantTx(tenantId, (tx) => tx.select().from(reconciliationState).where(and(eq(reconciliationState.tenantId, tenantId), eq(reconciliationState.entity, entity)))))[0];
    const save = (entity: string, checkpoint: Date | null, err?: string) => this.db.tenantTx(tenantId, (tx) =>
      tx.insert(reconciliationState).values({ tenantId, entity, checkpoint, lastRunAt: new Date(), lastError: err ?? null }).onConflictDoUpdate({ target: [reconciliationState.tenantId, reconciliationState.entity], set: { checkpoint, lastRunAt: new Date(), lastError: err ?? null } }));

    let stageChanges = 0; let oppCount = 0; let taskCount = 0;

    try {
      const c = await cp('opportunity');
      const since = c?.checkpoint ? new Date(c.checkpoint.getTime() - OVERLAP_MS).toISOString() : undefined;
      const opps = await this.crm.listOpportunities(tenant, { scope: { kind: 'all' }, updatedSince: since, archived: undefined, maxRecords: 5000 });
      // include archived changes too
      const archived = await this.crm.listOpportunities(tenant, { scope: { kind: 'all' }, updatedSince: since, archived: true, maxRecords: 5000 });
      for (const o of [...opps.items, ...archived.items]) {
        oppCount++;
        await this.db.tenantTx(tenantId, async (tx) => {
          const [prev] = await tx.select().from(crmIndex).where(and(eq(crmIndex.tenantId, tenantId), eq(crmIndex.entity, 'opportunity'), eq(crmIndex.externalId, o.id)));
          if (prev?.stageId && prev.stageId !== o.stageId) {
            const stage = tenant.pipeline.stages.find((s) => s.id === o.stageId);
            const changedAt = new Date(o.updatedAt);
            await tx.insert(stageHistory).values({ tenantId, opportunityId: o.id, fromStageId: prev.stageId, toStageId: o.stageId, terminalType: stage?.terminalType ?? null, changedAt, source: 'reconciliation', amountMicros: o.amountMicros ?? null, currency: o.currency ?? null }).onConflictDoNothing();
            stageChanges++;
          }
          await tx.insert(crmIndex).values({ tenantId, entity: 'opportunity', externalId: o.id, ownerMemberId: o.ownerMemberId, teamId: o.teamId, stageId: o.stageId, archived: o.archived, remoteUpdatedAt: new Date(o.updatedAt) })
            .onConflictDoUpdate({ target: [crmIndex.tenantId, crmIndex.entity, crmIndex.externalId], set: { ownerMemberId: o.ownerMemberId, teamId: o.teamId, stageId: o.stageId, archived: o.archived, remoteUpdatedAt: new Date(o.updatedAt), lastSeenAt: new Date() } });
        });
      }
      await save('opportunity', now);
    } catch (e) { await save('opportunity', (await cp('opportunity'))?.checkpoint ?? null, errorMessage(e)); throw e; }

    try {
      const c = await cp('task');
      const since = c?.checkpoint ? new Date(c.checkpoint.getTime() - OVERLAP_MS).toISOString() : undefined;
      const tasks = await this.crm.listTasks(tenant, { scope: { kind: 'all' }, updatedSince: since, includeArchived: true, maxRecords: 5000 });
      const touched = new Map<string, Set<string>>(); // ownerKey → dates to (re)schedule
      for (const t of tasks.items) {
        taskCount++;
        const date = t.dueDate ?? (t.dueAt ? t.dueAt.slice(0, 10) : undefined);
        await this.db.tenantTx(tenantId, (tx) =>
          tx.insert(crmIndex).values({ tenantId, entity: 'task', externalId: t.id, ownerMemberId: t.assigneeMemberId ?? t.ownerMemberId, teamId: t.teamId, status: t.status, dueAt: t.dueAt ? new Date(t.dueAt) : null, archived: t.archived, remoteUpdatedAt: new Date(t.updatedAt) })
            .onConflictDoUpdate({ target: [crmIndex.tenantId, crmIndex.entity, crmIndex.externalId], set: { ownerMemberId: t.assigneeMemberId ?? t.ownerMemberId, status: t.status, dueAt: t.dueAt ? new Date(t.dueAt) : null, archived: t.archived, remoteUpdatedAt: new Date(t.updatedAt), lastSeenAt: new Date() } }),
        );
        if (t.status === 'open' && !t.archived && date && (t.assigneeMemberId ?? t.ownerMemberId)) {
          const key = (t.assigneeMemberId ?? t.ownerMemberId)!;
          touched.set(key, (touched.get(key) ?? new Set()).add(date));
        }
      }
      // Tasks edited in Twenty's UI must appear in the next digest (AT-08): make sure the digest exists.
      for (const [ownerKey, dates] of touched) {
        const user = await this.userByOwnerKey(tenantId, ownerKey);
        if (user) for (const d of dates) await this.planner.ensureDigest(tenantId, user, d, now);
      }
      await save('task', now);
    } catch (e) { await save('task', (await cp('task'))?.checkpoint ?? null, errorMessage(e)); throw e; }

    this.log.info({ opportunities: oppCount, tasks: taskCount, stageChanges }, 'reconciliation finished');
    return { opportunities: oppCount, tasks: taskCount, stageChanges };
  }

  private async userByOwnerKey(tenantId: string, ownerKey: string): Promise<string | null> {
    const { users } = await import('../database/schema');
    const rows = await this.db.tenantTx(tenantId, (tx) => tx.select({ id: users.id, member: users.twentyMemberId }).from(users).where(eq(users.tenantId, tenantId)));
    return rows.find((u) => (u.member ?? u.id) === ownerKey)?.id ?? null;
  }
}
