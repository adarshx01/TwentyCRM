import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { drafts, idempotencyKeys, intakeRecords } from '../database/schema';
import { AllowedActionSchema } from '../common/schemas';
import type { TenantContext, UserContext } from '../common/types';
import { ActionAuthorizer } from '../crm/operations/action-authorizer';
import { OperationJournal } from '../crm/operations/operation-journal.service';
import { QueueService } from '../queue/queue.service';
import { QUEUES, type CrmWriteJob } from '../queue/queues';
import { AuditService } from '../audit/audit.service';
import { M } from '../observability/metrics';
import type { DraftRow } from './draft.service';

export type ConfirmResult =
  | { status: 'started'; operationId: string; draft: DraftRow }
  | { status: 'duplicate'; operationId: string; draft: DraftRow }
  | { status: 'stale'; draft: DraftRow }
  | { status: 'record_changed'; draft: DraftRow; message: string }
  | { status: 'rejected'; draft: DraftRow; message: string }
  | { status: 'expired' | 'cancelled' | 'not_confirmable'; draft: DraftRow }
  | { status: 'not_found' };

export interface ConfirmInput {
  tenant: TenantContext;
  user: UserContext;
  draftId: string;
  version: number;
  /** Full hash or the 8+ hex prefix carried by a button */
  hash: string;
  conversationId?: string;
  /** Provider event id / API Idempotency-Key */
  idempotencyKey: string;
}

/**
 * Confirmation contract (ACT-02..ACT-05, AT-04).
 * A confirmation is valid only for that actor, tenant, version, hash and (for chat) conversation.
 * Old buttons, other users, expired or cancelled drafts never write to the CRM, and a
 * repeated valid confirmation returns the same operation.
 */
@Injectable()
export class ConfirmationService {
  constructor(
    private readonly db: DbService,
    private readonly authorizer: ActionAuthorizer,
    private readonly journal: OperationJournal,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async confirm(input: ConfirmInput): Promise<ConfirmResult> {
    const { tenant, user } = input;
    const peek = await this.db.tenantTx(tenant.tenantId, async (tx) => (await tx.select().from(drafts).where(eq(drafts.id, input.draftId)))[0]);
    // Same answer for "missing", "other tenant" and "someone else's draft": no existence leak.
    if (!peek || peek.userId !== user.userId || (input.conversationId && peek.conversationId !== input.conversationId)) return { status: 'not_found' };

    // Replayed confirmation (same key) returns the stored result without touching anything.
    const [prior] = await this.db.tenantTx(tenant.tenantId, (tx) => tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, `confirm:${tenant.tenantId}:${input.idempotencyKey}`)));
    if (prior?.operationId) {
      M.duplicateSuppressed().inc({ kind: 'confirmation' });
      return { status: 'duplicate', operationId: prior.operationId, draft: peek };
    }

    // Authorization and record freshness are re-checked before committing (ACT-03).
    if (peek.state === 'awaiting_confirmation' && peek.version === input.version && peek.contentHash?.startsWith(input.hash)) {
      const action = AllowedActionSchema.parse(peek.proposedActions[0]);
      const intakeId = (peek.extractedData as any)?.intakeRecordId as string | undefined;
      const auth = await this.authorizer.authorize(tenant, user, action, { integration: !!intakeId });
      if (!auth.ok) {
        await this.audit.write({ tenantId: tenant.tenantId, userId: user.userId, action: 'draft.confirm_rejected', resourceType: 'draft', resourceId: peek.id, result: 'denied', metadata: { code: auth.code } });
        return auth.code === 'stale' ? { status: 'record_changed', draft: peek, message: auth.message } : { status: 'rejected', draft: peek, message: auth.message };
      }
    }

    return this.db.tenantTx(tenant.tenantId, async (tx): Promise<ConfirmResult> => {
      const [row] = await tx.select().from(drafts).where(eq(drafts.id, input.draftId)).for('update'); // serialize per draft
      if (!row) return { status: 'not_found' };
      const matches = row.version === input.version && !!row.contentHash && row.contentHash.startsWith(input.hash);

      if (row.state === 'committing' || row.state === 'committed') {
        if (!matches || !row.operationId) return { status: 'stale', draft: row };
        M.duplicateSuppressed().inc({ kind: 'confirmation' });
        return { status: 'duplicate', operationId: row.operationId, draft: row };
      }
      if (row.state === 'cancelled') return { status: 'cancelled', draft: row };
      if (row.state === 'expired' || (row.expiresAt && row.expiresAt < new Date() && row.state !== 'needs_repair')) {
        if (row.state !== 'expired') await tx.update(drafts).set({ state: 'expired', updatedAt: new Date() }).where(eq(drafts.id, row.id));
        return { status: 'expired', draft: row };
      }
      if (row.state !== 'awaiting_confirmation') return { status: 'not_confirmable', draft: row };
      if (!matches) return { status: 'stale', draft: row };

      const action = AllowedActionSchema.parse(row.proposedActions[0]);
      // Approving an intake review item runs the SAME idempotent operation the automatic path would (IN-11, IN-12).
      const intakeId = (row.extractedData as any)?.intakeRecordId as string | undefined;
      const ownerUserId = intakeId ? (action as any).ownerUserId ?? user.userId : user.userId;
      const { op } = await this.journal.create(tx, {
        tenantId: tenant.tenantId, userId: ownerUserId, draftId: row.id, draftVersion: row.version, type: action.type, channel: intakeId ? 'email' : row.channel, action,
        idempotencyKey: intakeId ? `intake:${intakeId}` : `confirm:${row.id}:${row.version}`, sourceEventId: row.sourceEventIds[0], correlationId: undefined,
      });
      if (intakeId) {
        await tx.update(intakeRecords).set({ state: 'committing', operationId: op.id, reviewedBy: user.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(intakeRecords.id, intakeId));
      }
      await tx.update(drafts).set({ state: 'committing', operationId: op.id, updatedAt: new Date() }).where(eq(drafts.id, row.id));
      await tx.insert(idempotencyKeys).values({ key: `confirm:${tenant.tenantId}:${input.idempotencyKey}`, tenantId: tenant.tenantId, operationId: op.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) }).onConflictDoNothing();
      // Enqueue in the same transaction: confirmed means queued (no "saved but never queued" gap).
      await this.queue.sendInTx(tx, QUEUES.CRM_WRITE, { operationId: op.id } satisfies CrmWriteJob, { tenantId: tenant.tenantId, userId: user.userId, idempotencyKey: `crm:${op.id}` });
      await this.audit.writeTx(tx, { tenantId: tenant.tenantId, userId: user.userId, channel: row.channel, sourceEventId: input.idempotencyKey, action: 'draft.confirmed', resourceType: 'draft', resourceId: row.id, confirmationId: `${row.id}:v${row.version}` });
      M.draftTransitions().inc({ from: 'awaiting_confirmation', to: 'committing' });
      return { status: 'started', operationId: op.id, draft: { ...row, state: 'committing', operationId: op.id } };
    });
  }
}
