import { Inject, Injectable } from '@nestjs/common';
import type { TenantContext, UserContext } from '../../common/types';
import type { AllowedAction } from '../../common/schemas';
import { canUserAccess, roleMayPerform } from '../../common/scope';
import { CRM_ADAPTER, type CrmAdapter, type CrmBase } from '../crm-adapter.interface';
import { IdentityService } from '../../identity/identity.service';

export type AuthResult =
  | { ok: true }
  | { ok: false; code: 'denied' | 'not_found' | 'stale' | 'invalid' | 'archived' | 'not_archived'; message: string };

const NOT_FOUND = { ok: false, code: 'not_found', message: "I couldn't find that record in your accessible records." } as const;

/**
 * Server-side authorization for executable actions (SEC-02, ACT-03, IAM-05).
 * Run at preview time AND again at commit time — current role, scope, record
 * existence/version and configuration are all re-read, never trusted from the draft.
 * Inaccessible and non-existent records are indistinguishable to the user.
 */
@Injectable()
export class ActionAuthorizer {
  constructor(
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    private readonly identity: IdentityService,
  ) {}

  private async load(tenant: TenantContext, entity: 'person' | 'company' | 'opportunity' | 'task', id: string): Promise<(CrmBase & Record<string, any>) | null> {
    switch (entity) {
      case 'person': return this.crm.getPerson(tenant, id);
      case 'company': return this.crm.getCompany(tenant, id);
      case 'opportunity': return this.crm.getOpportunity(tenant, id);
      case 'task': return this.crm.getTask(tenant, id);
    }
  }

  private async checkTarget(tenant: TenantContext, user: UserContext, entity: 'person' | 'company' | 'opportunity' | 'task', id: string, opts: { expectedVersion?: string; mustBeArchived?: boolean } = {}): Promise<AuthResult> {
    const rec = await this.load(tenant, entity, id);
    if (!rec || !canUserAccess(user, rec)) return NOT_FOUND;
    if (opts.mustBeArchived && !rec.archived) return { ok: false, code: 'not_archived', message: 'That record is not archived.' };
    if (!opts.mustBeArchived && rec.archived) return { ok: false, code: 'archived', message: 'That record is archived. Restore it first.' };
    if (opts.expectedVersion && rec.updatedAt !== opts.expectedVersion) {
      return { ok: false, code: 'stale', message: 'That record changed after the preview. Please review the updated preview.' };
    }
    return { ok: true };
  }

  async authorize(tenant: TenantContext, user: UserContext, action: AllowedAction, opts: { integration?: boolean } = {}): Promise<AuthResult> {
    if (!roleMayPerform(user.role, action.type)) {
      return { ok: false, code: 'denied', message: 'Your role cannot perform this action. A manager, CXO or administrator can.' };
    }
    switch (action.type) {
      case 'capture_lead': {
        const e = action.existing;
        // Automatic intake runs as the workspace integration role: existing contacts are matched tenant-wide (IN-07/IN-09).
        const scoped = opts.integration ? { ...user, role: 'cxo' as const } : user;
        if (e?.personId) { const r = await this.checkTarget(tenant, scoped, 'person', e.personId); if (!r.ok) return r; }
        if (e?.companyId) { const r = await this.checkTarget(tenant, scoped, 'company', e.companyId); if (!r.ok) return r; }
        if (e?.opportunityId) { const r = await this.checkTarget(tenant, scoped, 'opportunity', e.opportunityId); if (!r.ok) return r; }
        if (action.opportunity?.stageId && !tenant.pipeline.stages.some((s) => s.id === action.opportunity!.stageId)) {
          return { ok: false, code: 'invalid', message: `Stage "${action.opportunity.stageId}" is not in this workspace's pipeline.` };
        }
        if (!action.person && !action.company && !e?.personId && !e?.companyId) {
          return { ok: false, code: 'invalid', message: 'A contact or a company is needed to save a lead.' };
        }
        for (const t of action.tasks) {
          if (t.type === 'meeting' && (!t.dueDate || !t.dueTime)) return { ok: false, code: 'invalid', message: 'A meeting needs an explicit date and time.' };
        }
        if (action.ownerUserId && action.ownerUserId !== user.userId) {
          const owner = await this.identity.getActiveUser(tenant.tenantId, action.ownerUserId);
          if (!owner) return { ok: false, code: 'invalid', message: 'The assigned owner is not an active member.' };
        }
        return { ok: true };
      }
      case 'update_stage': {
        const stage = tenant.pipeline.stages.find((s) => s.id === action.newStageId);
        if (!stage) return { ok: false, code: 'invalid', message: `"${action.newStageId}" is not a stage in this workspace's pipeline.` };
        const t = await this.checkTarget(tenant, user, 'opportunity', action.opportunityId, { expectedVersion: action.expectedVersion });
        if (!t.ok) return t;
        const opp = (await this.crm.getOpportunity(tenant, action.opportunityId))!;
        if (opp.stageId === stage.id) return { ok: false, code: 'invalid', message: `This opportunity is already in ${stage.label}.` };
        const missing = (stage.requiredFields ?? []).filter((f) => {
          if (f === 'amount') return opp.amountMicros == null && action.amount == null;
          if (f === 'lostReason') return !opp.lostReason && !action.lostReason;
          if (f === 'closeDate') return !opp.closeDate;
          return false;
        });
        if (missing.length) return { ok: false, code: 'invalid', message: `Moving to ${stage.label} needs: ${missing.join(', ')}.` };
        return { ok: true };
      }
      case 'add_note':
        return this.checkTarget(tenant, user, action.targetType, action.targetId, { expectedVersion: action.expectedVersion });
      case 'create_task':
        if (action.targetType && action.targetId) return this.checkTarget(tenant, user, action.targetType, action.targetId);
        return { ok: true };
      case 'reschedule':
        return this.checkTarget(tenant, user, 'task', action.taskId, { expectedVersion: action.expectedVersion });
      case 'assign': {
        const t = await this.checkTarget(tenant, user, action.targetType, action.targetId, { expectedVersion: action.expectedVersion });
        if (!t.ok) return t;
        const owner = await this.identity.getActiveUser(tenant.tenantId, action.newOwnerUserId);
        if (!owner) return { ok: false, code: 'invalid', message: 'That person is not an active member of this workspace.' };
        if (user.role === 'manager' && owner.user.userId !== user.userId && !(owner.user.teamId && user.managedTeamIds.includes(owner.user.teamId))) {
          return { ok: false, code: 'denied', message: 'You can only assign within the teams you manage.' };
        }
        for (const id of action.cascadeTaskIds) { const r = await this.checkTarget(tenant, user, 'task', id); if (!r.ok) return r; }
        return { ok: true };
      }
      case 'archive': {
        const t = await this.checkTarget(tenant, user, action.targetType, action.targetId, { expectedVersion: action.expectedVersion });
        if (!t.ok) return t;
        for (const id of action.cascadeTaskIds) { const r = await this.checkTarget(tenant, user, 'task', id); if (!r.ok) return r; }
        return { ok: true };
      }
      case 'restore':
        return this.checkTarget(tenant, user, action.targetType, action.targetId, { expectedVersion: action.expectedVersion, mustBeArchived: true });
    }
  }
}
