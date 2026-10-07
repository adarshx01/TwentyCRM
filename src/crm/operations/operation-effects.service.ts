import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../database/db.service';
import { crmIndex, drafts, mediaObjects, operations, stageHistory, type OperationStep } from '../../database/schema';
import type { AllowedAction } from '../../common/schemas';
import type { TenantContext, UserContext } from '../../common/types';
import { ownerKeyOf } from '../crm-adapter.interface';
import { AuditService } from '../../audit/audit.service';
import { SchedulePlanner } from '../../reminders/schedule-planner.service';
import { Inject } from '@nestjs/common';
import { CRM_ADAPTER, type CrmAdapter } from '../crm-adapter.interface';
import { describeStep } from './action-planner';
import { getLogger } from '../../observability/logger';
import type { OperationRow } from './operation-journal.service';

export interface OperationResult {
  reference: string;
  refs: Array<{ kind: string; id: string; url?: string; label: string }>;
  summary: string[];
}

/** Everything that must happen exactly once when an operation reaches `committed`. */
@Injectable()
export class OperationEffects {
  private readonly log = getLogger('operation-effects');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly planner: SchedulePlanner,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
  ) {}

  static reference(operationId: string): string {
    return `OP-${operationId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  }

  buildResult(op: Pick<OperationRow, 'id'>, steps: OperationStep[], tenant: TenantContext): OperationResult {
    const refs: OperationResult['refs'] = [];
    for (const s of steps) {
      if (s.status !== 'committed' || !s.externalId) continue;
      const kind = s.key.startsWith('task') || s.kind === 'update_task' ? 'task' : s.key === 'person' || s.key === 'person_fill' ? 'person' : s.key === 'company' ? 'company' : s.key === 'opportunity' || s.key === 'stage' ? 'opportunity' : s.key.startsWith('note') ? 'note' : null;
      if (!kind || refs.some((r) => r.kind === kind && r.id === s.externalId)) continue;
      refs.push({ kind, id: s.externalId, label: describeStep(s), url: kind === 'note' ? undefined : this.crm.recordUrl(tenant, kind as any, s.externalId) });
    }
    return { reference: OperationEffects.reference(op.id), refs, summary: [...new Set(steps.filter((s) => s.status === 'committed').map(describeStep))] };
  }

  async finalize(op: OperationRow, steps: OperationStep[], tenant: TenantContext, actor: UserContext, action: AllowedAction, results: Map<string, string>): Promise<OperationResult> {
    const result = this.buildResult(op, steps, tenant);
    const source = op.channel === 'email' ? 'intake' : 'chat';
    const now = new Date();
    const terminal = (stageId: string) => tenant.pipeline.stages.find((s) => s.id === stageId)?.terminalType ?? null;
    const ownerUserId = (action as any).ownerUserId ?? actor.userId;
    const ownerKey = ownerUserId === actor.userId ? ownerKeyOf(actor) : undefined;

    await this.db.tenantTx(op.tenantId, async (tx) => {
      await tx.update(operations).set({ state: 'committed', result: result as any, leaseOwner: null, leaseUntil: null, errorInfo: null, updatedAt: now }).where(eq(operations.id, op.id));
      if (op.draftId) {
        await tx.update(drafts).set({ state: 'committed', committedAt: now, updatedAt: now }).where(and(eq(drafts.id, op.draftId), eq(drafts.state, 'committing')));
        const retainDays = tenant.retention.mediaRetentionDays ?? 30;
        await tx.update(mediaObjects).set({ confirmedAt: now, deleteAfter: new Date(now.getTime() + retainDays * 86_400_000) }).where(eq(mediaObjects.draftId, op.draftId));
      }

      // Stage history for reporting (SYNC-03): chat/intake transitions are recorded as they happen.
      const oppStep = steps.find((s) => s.key === 'opportunity' && s.kind === 'create_opportunity' && s.status === 'committed');
      if (oppStep?.externalId) {
        const stageId = (action as any).opportunity?.stageId ?? tenant.pipeline.defaultInitialStage;
        await tx.insert(stageHistory).values({ tenantId: op.tenantId, opportunityId: oppStep.externalId, fromStageId: null, toStageId: stageId, terminalType: terminal(stageId), changedAt: now, source }).onConflictDoNothing();
        await tx.insert(crmIndex).values({ tenantId: op.tenantId, entity: 'opportunity', externalId: oppStep.externalId, ownerMemberId: ownerKey, teamId: actor.teamId, stageId, status: 'open', archived: false, remoteUpdatedAt: now }).onConflictDoNothing();
      }
      const stageStep = steps.find((s) => s.kind === 'update_stage' && s.status === 'committed');
      if (stageStep) {
        const to = String(stageStep.payload?.stageId);
        await tx.insert(stageHistory).values({
          tenantId: op.tenantId, opportunityId: String(stageStep.payload?.id), fromStageId: (stageStep.payload?.fromStageId as string) ?? null, toStageId: to, terminalType: terminal(to), changedAt: now, source,
          amountMicros: (stageStep.payload?.prevAmountMicros as number) ?? null, currency: (stageStep.payload?.prevCurrency as string) ?? null,
        }).onConflictDoNothing();
        await tx.insert(crmIndex).values({ tenantId: op.tenantId, entity: 'opportunity', externalId: String(stageStep.payload?.id), stageId: to, archived: false, remoteUpdatedAt: now })
          .onConflictDoUpdate({ target: [crmIndex.tenantId, crmIndex.entity, crmIndex.externalId], set: { stageId: to, lastSeenAt: now, remoteUpdatedAt: now } });
      }

      await this.audit.writeTx(tx, {
        tenantId: op.tenantId, userId: op.userId, channel: op.channel ?? undefined, sourceEventId: op.sourceEventId ?? undefined, action: `operation.${action.type}`,
        resourceType: 'operation', resourceId: op.id, confirmationId: op.draftId ? `${op.draftId}:v${op.draftVersion ?? 0}` : undefined,
        changedFields: steps.filter((s) => s.status === 'committed').map((s) => `${s.kind}:${s.externalId}`), result: 'success',
      });
    });

    // Reminders follow confirmed task creation/edit automatically (REM-03).
    try {
      const dates = new Set<string>();
      for (const s of steps) {
        if (s.status !== 'committed') continue;
        if (s.kind === 'create_task' && (s.payload?.task as any)?.dueDate) dates.add((s.payload!.task as any).dueDate);
        if (s.kind === 'update_task' && s.payload?.date) dates.add(String(s.payload.date));
      }
      for (const d of dates) await this.planner.ensureDigest(op.tenantId, ownerUserId, d);
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'digest scheduling after commit failed; planner will recover');
    }
    void results;
    return result;
  }
}
