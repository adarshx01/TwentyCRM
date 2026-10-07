import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { archiveRequests, users } from '../database/schema';
import type { TenantContext, UserContext } from '../common/types';
import { CRM_ADAPTER, type CrmAdapter } from '../crm/crm-adapter.interface';
import { canUserAccess, scopeFilterFor } from '../common/scope';
import { can } from '../access/permissions';
import { ActionAuthorizer } from '../crm/operations/action-authorizer';
import { OperationJournal } from '../crm/operations/operation-journal.service';
import { OperationEffects } from '../crm/operations/operation-effects.service';
import { QueueService } from '../queue/queue.service';
import { QUEUES, type CrmWriteJob } from '../queue/queues';
import { AuditService } from '../audit/audit.service';
import { UserFacingError } from '../common/errors';

type Target = { entity: 'person' | 'company' | 'opportunity'; id: string; label: string };
type Row = typeof archiveRequests.$inferSelect;

/**
 * "Request archive" (§4): a salesperson cannot archive, but can ask. Nothing changes in the CRM until a manager (for
 * records in their scope), a CXO or a client admin approves; approval runs the SAME journalled archive operation a
 * chat confirmation would, under the approver's identity, re-authorized at commit time (ACT-03).
 */
@Injectable()
export class ArchiveRequestService {
  constructor(
    private readonly db: DbService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    private readonly authorizer: ActionAuthorizer,
    private readonly journal: OperationJournal,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  private load(tenant: TenantContext, t: { entity: Target['entity']; id: string }) {
    return t.entity === 'person' ? this.crm.getPerson(tenant, t.id) : t.entity === 'company' ? this.crm.getCompany(tenant, t.id) : this.crm.getOpportunity(tenant, t.id);
  }

  async create(tenant: TenantContext, user: UserContext, target: Target, reason?: string): Promise<{ request: Row; existing: boolean }> {
    if (!can(user.role, 'records.archive.request')) throw new UserFacingError('Your role archives directly; no request is needed.', 'REQUEST_FORBIDDEN');
    const rec = await this.load(tenant, target);
    if (!rec || !canUserAccess(user, rec)) throw new UserFacingError("I couldn't find that record in your accessible records.", 'NOT_FOUND');
    if (rec.archived) throw new UserFacingError('That record is already archived.', 'BAD_STATE');
    return this.db.tenantTx(tenant.tenantId, async (tx) => {
      const [pending] = await tx.select().from(archiveRequests).where(and(eq(archiveRequests.tenantId, tenant.tenantId), eq(archiveRequests.targetType, target.entity), eq(archiveRequests.targetId, target.id), eq(archiveRequests.state, 'pending')));
      if (pending) return { request: pending, existing: true };
      const [row] = await tx.insert(archiveRequests).values({
        tenantId: tenant.tenantId, requestedBy: user.userId, targetType: target.entity, targetId: target.id, targetLabel: target.label.slice(0, 255),
        targetOwnerKey: rec.ownerMemberId ?? null, targetTeamId: rec.teamId ?? null, reason: reason?.slice(0, 1000) ?? null,
      }).returning();
      await this.audit.writeTx(tx, { tenantId: tenant.tenantId, userId: user.userId, action: 'archive.requested', resourceType: target.entity, resourceId: target.id, metadata: { requestId: row.id } });
      return { request: row, existing: false };
    });
  }

  /** Requests an approver may decide: their record scope applies to the target as it was when requested. */
  async listForApprover(tenant: TenantContext, approver: UserContext, state: 'pending' | 'all' = 'pending') {
    if (!can(approver.role, 'approvals.decide')) return [];
    const rows = await this.db.tenantTx(tenant.tenantId, (tx) => tx.select().from(archiveRequests).where(and(eq(archiveRequests.tenantId, tenant.tenantId), ...(state === 'pending' ? [eq(archiveRequests.state, 'pending')] : []))).orderBy(desc(archiveRequests.createdAt)).limit(100));
    return this.withNames(tenant.tenantId, rows.filter((r) => canUserAccess(approver, { ownerMemberId: r.targetOwnerKey ?? undefined, teamId: r.targetTeamId ?? undefined })));
  }

  async listMine(tenant: TenantContext, user: UserContext) {
    const rows = await this.db.tenantTx(tenant.tenantId, (tx) => tx.select().from(archiveRequests).where(and(eq(archiveRequests.tenantId, tenant.tenantId), eq(archiveRequests.requestedBy, user.userId))).orderBy(desc(archiveRequests.createdAt)).limit(50));
    return this.withNames(tenant.tenantId, rows);
  }

  private async withNames(tenantId: string, rows: Row[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter(Boolean) as string[])];
    const names = ids.length ? await this.db.tenantTx(tenantId, (tx) => tx.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids))) : [];
    const name = (id?: string | null) => names.find((n) => n.id === id)?.name ?? null;
    return rows.map((r) => ({ id: r.id, targetType: r.targetType, targetId: r.targetId, targetLabel: r.targetLabel, reason: r.reason, state: r.state, requestedBy: name(r.requestedBy), requestedAt: r.createdAt, decidedBy: name(r.decidedBy), decidedAt: r.decidedAt, decisionNote: r.decisionNote, operationReference: r.operationId ? OperationEffects.reference(r.operationId) : null }));
  }

  async decide(tenant: TenantContext, approver: UserContext, id: string, decision: 'approve' | 'reject', note?: string, channel = 'web') {
    if (!can(approver.role, 'approvals.decide') || !can(approver.role, 'records.archive')) throw new UserFacingError('Your role cannot decide archive requests.', 'APPROVAL_FORBIDDEN');
    const [req] = await this.db.tenantTx(tenant.tenantId, (tx) => tx.select().from(archiveRequests).where(and(eq(archiveRequests.id, id), eq(archiveRequests.tenantId, tenant.tenantId))));
    // Out-of-scope requests are indistinguishable from missing ones.
    if (!req || !canUserAccess(approver, { ownerMemberId: req.targetOwnerKey ?? undefined, teamId: req.targetTeamId ?? undefined })) throw new UserFacingError('Request not found.', 'NOT_FOUND');
    if (req.state !== 'pending') throw new UserFacingError(`This request is already ${req.state}.`, 'BAD_STATE');

    if (decision === 'reject') {
      await this.db.tenantTx(tenant.tenantId, async (tx) => {
        await tx.update(archiveRequests).set({ state: 'rejected', decidedBy: approver.userId, decidedAt: new Date(), decisionNote: note?.slice(0, 1000) ?? null, updatedAt: new Date() }).where(and(eq(archiveRequests.id, id), eq(archiveRequests.state, 'pending')));
        await this.audit.writeTx(tx, { tenantId: tenant.tenantId, userId: approver.userId, action: 'archive.request_rejected', resourceType: req.targetType, resourceId: req.targetId, metadata: { requestId: id } });
      });
      return { state: 'rejected' as const };
    }

    // Approval: re-read the record NOW and authorize the archive for the approver (scope, existence, archived state).
    const rec = await this.load(tenant, { entity: req.targetType, id: req.targetId });
    if (!rec || !canUserAccess(approver, rec)) throw new UserFacingError('Request not found.', 'NOT_FOUND');
    const cascade = req.targetType === 'opportunity'
      ? (await this.crm.listTasks(tenant, { scope: scopeFilterFor(approver), status: 'open', opportunityId: req.targetId, maxRecords: 50 })).items.filter((t) => canUserAccess(approver, t)).map((t) => t.id)
      : [];
    const action = { type: 'archive' as const, targetType: req.targetType, targetId: req.targetId, expectedVersion: rec.updatedAt, cascadeTaskIds: cascade };
    const auth = await this.authorizer.authorize(tenant, approver, action);
    if (!auth.ok) throw new UserFacingError(auth.message, auth.code === 'denied' ? 'APPROVAL_FORBIDDEN' : 'BAD_STATE');
    const opId = await this.db.tenantTx(tenant.tenantId, async (tx) => {
      const [locked] = await tx.select().from(archiveRequests).where(eq(archiveRequests.id, id)).for('update');
      if (locked.state !== 'pending') throw new UserFacingError(`This request is already ${locked.state}.`, 'BAD_STATE');
      const { op } = await this.journal.create(tx, { tenantId: tenant.tenantId, userId: approver.userId, type: 'archive', channel, action, idempotencyKey: `archive-request:${id}` });
      await tx.update(archiveRequests).set({ state: 'approved', decidedBy: approver.userId, decidedAt: new Date(), decisionNote: note?.slice(0, 1000) ?? null, operationId: op.id, updatedAt: new Date() }).where(eq(archiveRequests.id, id));
      await this.queue.sendInTx(tx, QUEUES.CRM_WRITE, { operationId: op.id } satisfies CrmWriteJob, { tenantId: tenant.tenantId, userId: approver.userId, idempotencyKey: `crm:${op.id}` });
      await this.audit.writeTx(tx, { tenantId: tenant.tenantId, userId: approver.userId, action: 'archive.request_approved', resourceType: req.targetType, resourceId: req.targetId, metadata: { requestId: id, operationId: op.id } });
      return op.id;
    });
    return { state: 'approved' as const, operationId: opId, reference: OperationEffects.reference(opId) };
  }

  async cancel(tenant: TenantContext, user: UserContext, id: string) {
    const n = await this.db.tenantTx(tenant.tenantId, async (tx) => {
      const r = await tx.update(archiveRequests).set({ state: 'cancelled', updatedAt: new Date() }).where(and(eq(archiveRequests.id, id), eq(archiveRequests.requestedBy, user.userId), eq(archiveRequests.state, 'pending'))).returning({ id: archiveRequests.id });
      return r.length;
    });
    if (!n) throw new UserFacingError('Request not found.', 'NOT_FOUND');
    return { state: 'cancelled' as const };
  }
}
