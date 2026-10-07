import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService, type Tx } from '../../database/db.service';
import { drafts, operations, type OperationStep } from '../../database/schema';
import { AllowedActionSchema, type AllowedAction } from '../../common/schemas';
import { CRM_ADAPTER, CrmPermanentError, type CrmAdapter } from '../crm-adapter.interface';
import { IdentityService } from '../../identity/identity.service';
import { WorkspaceLimiter } from '../../ratelimit/workspace-limiter';
import { AuditService } from '../../audit/audit.service';
import { PermanentError, RetryLaterError, errorMessage } from '../../common/errors';
import { M } from '../../observability/metrics';
import { getLogger } from '../../observability/logger';
import { ActionAuthorizer } from './action-authorizer';
import { describeStep, planSteps } from './action-planner';
import { StepExecutor, type StepContext } from './step-executor';
import { OperationEffects } from './operation-effects.service';

export type OperationRow = typeof operations.$inferSelect;

export type ExecutionOutcome =
  | { status: 'committed'; op: OperationRow }
  | { status: 'failed'; op: OperationRow; reason: string }
  | { status: 'needs_repair'; op: OperationRow; reason: string }
  | { status: 'stale'; op: OperationRow; reason: string }
  | { status: 'denied'; op: OperationRow; reason: string }
  | { status: 'revoked'; op: OperationRow }
  | { status: 'noop'; op?: OperationRow };

export interface CreateOperationInput {
  tenantId: string;
  userId: string;
  draftId?: string;
  draftVersion?: number;
  type: string;
  channel?: string;
  action: AllowedAction;
  idempotencyKey: string;
  sourceEventId?: string;
  correlationId?: string;
}

const LEASE_SECONDS = 90;

/**
 * Operation journal (ACT-04, ACT-05, AT-13).
 *
 * Multi-record writes are never assumed transactional in Twenty. Each step is
 * persisted before and after it runs, with a stable CRM operation key. A restart,
 * timeout or duplicate delivery resumes only the missing steps and recovers
 * records created by a previous attempt by looking them up by operation key.
 * Nothing is rolled back by deleting pre-existing records.
 */
@Injectable()
export class OperationJournal {
  private readonly log = getLogger('journal');

  constructor(
    private readonly db: DbService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    private readonly identity: IdentityService,
    private readonly limiter: WorkspaceLimiter,
    private readonly authorizer: ActionAuthorizer,
    private readonly executor: StepExecutor,
    private readonly effects: OperationEffects,
    private readonly audit: AuditService,
  ) {}

  /** Insert an operation (idempotent on idempotencyKey). Call inside the caller's transaction. */
  async create(tx: Tx, input: CreateOperationInput): Promise<{ op: OperationRow; created: boolean }> {
    const action = AllowedActionSchema.parse(input.action);
    const steps = planSteps(action);
    const [inserted] = await tx
      .insert(operations)
      .values({
        tenantId: input.tenantId, userId: input.userId, draftId: input.draftId, draftVersion: input.draftVersion, type: input.type, channel: input.channel,
        actions: [action as any], steps, idempotencyKey: input.idempotencyKey, sourceEventId: input.sourceEventId, correlationId: input.correlationId,
      })
      .onConflictDoNothing({ target: operations.idempotencyKey })
      .returning();
    if (inserted) return { op: inserted, created: true };
    const [existing] = await tx.select().from(operations).where(eq(operations.idempotencyKey, input.idempotencyKey));
    return { op: existing, created: false };
  }

  async get(tenantId: string, id: string): Promise<OperationRow | null> {
    const [op] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(operations).where(eq(operations.id, id)));
    return op ?? null;
  }

  /** Acquire the execution lease; a crashed worker's lease expires and is taken over. */
  private async claim(tenantId: string, operationId: string, workerId: string): Promise<OperationRow | 'terminal' | 'busy'> {
    return this.db.tenantTx(tenantId, async (tx) => {
      const [row] = await tx
        .update(operations)
        .set({ state: 'in_progress', leaseOwner: workerId, leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`, updatedAt: new Date() })
        .where(and(eq(operations.id, operationId), sql`${operations.state} in ('pending','in_progress')`, sql`(${operations.leaseUntil} is null or ${operations.leaseUntil} < now() or ${operations.leaseOwner} = ${workerId})`))
        .returning();
      if (row) return row;
      const [cur] = await tx.select({ state: operations.state }).from(operations).where(eq(operations.id, operationId));
      return !cur || ['committed', 'failed', 'needs_repair'].includes(cur.state) ? 'terminal' : 'busy';
    });
  }

  private async persist(op: OperationRow, steps: OperationStep[], extra: Partial<typeof operations.$inferInsert> = {}): Promise<void> {
    await this.db.tenantTx(op.tenantId, (tx) =>
      tx.update(operations).set({ steps, leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`, updatedAt: new Date(), ...extra }).where(eq(operations.id, op.id)),
    );
  }

  /** Execute (or resume) an operation. Throws RetryLaterError / transient errors for the queue to retry. */
  async execute(tenantId: string, operationId: string, workerId: string): Promise<ExecutionOutcome> {
    const claimed = await this.claim(tenantId, operationId, workerId);
    if (claimed === 'terminal') return { status: 'noop' };
    if (claimed === 'busy') throw new RetryLaterError(3000, 'operation_leased');
    const op = claimed;
    const end = M.crmOpDuration().startTimer({ type: op.type });

    try {
      // Revocation / role change blocks commits (IAM-05, AT-14).
      const live = await this.identity.getActiveUser(tenantId, op.userId);
      if (!live) return await this.terminate(op, 'revoked', 'The user is no longer active; the operation was stopped.');
      const { tenant, user: actor } = live;
      const steps: OperationStep[] = (op.steps as OperationStep[]).map((s) => ({ ...s }));
      const action = AllowedActionSchema.parse(op.actions[0]);
      const fresh = steps.every((s) => s.status === 'pending');

      // Re-authorize and re-read before the first write (ACT-03). Resumed operations were already authorized.
      if (fresh) {
        const auth = await this.authorizer.authorize(tenant, actor, action, { integration: op.channel === 'email' });
        if (!auth.ok) return await this.terminate(op, auth.code === 'stale' ? 'stale' : 'denied', auth.message);
      }

      const lease = await this.limiter.acquireWriteLease(tenant.twentyWorkspaceId);
      try {
        const results = new Map<string, string>();
        const stepCtx: StepContext = {
          tenant, actor, operationId: op.id, channel: op.channel ?? undefined,
          sourceEventIds: op.sourceEventId ? [op.sourceEventId] : [], results, ownerUserId: (action as any).ownerUserId,
        };
        for (const s of steps) {
          if (s.status === 'committed' || s.status === 'skipped') { if (s.externalId) results.set(s.key, s.externalId); continue; }
          s.status = 'in_progress';
          s.attempts = (s.attempts ?? 0) + 1;
          s.attemptedAt = new Date().toISOString();
          if (s.kind === 'update_stage' && !s.payload?.fromStageId) {
            const cur = await this.crm.getOpportunity(tenant, String(s.payload?.id));
            s.payload = { ...s.payload, fromStageId: cur?.stageId, prevAmountMicros: cur?.amountMicros, prevCurrency: cur?.currency };
          }
          await this.persist(op, steps);
          try {
            const id = await this.executor.run(s, stepCtx);
            s.status = 'committed';
            s.externalId = id;
            s.completedAt = new Date().toISOString();
            s.error = undefined;
            results.set(s.key, id);
            await this.persist(op, steps);
          } catch (e) {
            if (e instanceof RetryLaterError) { await this.persist(op, steps); throw e; }
            if (e instanceof CrmPermanentError || e instanceof PermanentError) {
              s.status = 'failed';
              s.error = errorMessage(e).slice(0, 300);
              const anyDone = steps.some((x) => x.status === 'committed');
              const state = anyDone ? 'needs_repair' : 'failed';
              await this.persist(op, steps, { state, errorInfo: { step: s.key, message: s.error }, leaseUntil: null, leaseOwner: null });
              await this.failDraft(op, anyDone);
              M.crmOpResults().inc({ type: op.type, result: state });
              return { status: state, op: { ...op, steps, state }, reason: s.error };
            }
            // Transient (timeout, 5xx, network): keep step in_progress; the retry will look it up by operation key.
            s.error = errorMessage(e).slice(0, 300);
            await this.persist(op, steps, { retryCount: sql`${operations.retryCount} + 1` as any, errorInfo: { step: s.key, message: s.error, transient: true } });
            throw e;
          }
        }

        const result = await this.effects.finalize(op, steps, tenant, actor, action, results);
        const [committed] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(operations).where(eq(operations.id, op.id)));
        M.crmOpResults().inc({ type: op.type, result: 'committed' });
        void result;
        return { status: 'committed', op: committed };
      } finally {
        await lease.release();
      }
    } finally {
      end();
    }
  }

  /** Stop without writing: nothing was committed, so the draft is released or reopened. */
  private async terminate(op: OperationRow, kind: 'revoked' | 'denied' | 'stale', reason: string): Promise<ExecutionOutcome> {
    const state = 'failed' as const;
    await this.db.tenantTx(op.tenantId, async (tx) => {
      await tx.update(operations).set({ state, errorInfo: { reason: kind, message: reason }, leaseUntil: null, leaseOwner: null, updatedAt: new Date() }).where(eq(operations.id, op.id));
      if (op.draftId && kind !== 'stale') {
        await tx.update(drafts).set({ state: 'cancelled', updatedAt: new Date() }).where(and(eq(drafts.id, op.draftId), eq(drafts.state, 'committing')));
      }
      await this.audit.writeTx(tx, { tenantId: op.tenantId, userId: op.userId, action: `operation.${kind}`, resourceType: 'operation', resourceId: op.id, result: 'denied', metadata: { reason } });
    });
    M.crmOpResults().inc({ type: op.type, result: kind });
    const row = { ...op, state } as OperationRow;
    if (kind === 'revoked') return { status: 'revoked', op: row };
    return { status: kind, op: row, reason };
  }

  private async failDraft(op: OperationRow, partial: boolean): Promise<void> {
    if (!op.draftId) return;
    await this.db.tenantTx(op.tenantId, (tx) =>
      tx.update(drafts).set({ state: 'needs_repair', updatedAt: new Date() }).where(and(eq(drafts.id, op.draftId!), eq(drafts.state, 'committing'))),
    );
    void partial;
  }

  /** Called when the queue has exhausted retries (final failure hook). */
  async markNeedsRepair(tenantId: string, operationId: string, reason: string): Promise<OperationRow | null> {
    return this.db.tenantTx(tenantId, async (tx) => {
      const [op] = await tx.select().from(operations).where(eq(operations.id, operationId));
      if (!op || ['committed', 'failed'].includes(op.state)) return op ?? null;
      const anyDone = (op.steps as OperationStep[]).some((s) => s.status === 'committed');
      const [row] = await tx.update(operations).set({ state: anyDone ? 'needs_repair' : 'failed', errorInfo: { message: reason }, leaseUntil: null, leaseOwner: null, updatedAt: new Date() }).where(eq(operations.id, operationId)).returning();
      if (op.draftId) await tx.update(drafts).set({ state: 'needs_repair', updatedAt: new Date() }).where(and(eq(drafts.id, op.draftId), eq(drafts.state, 'committing')));
      await this.audit.writeTx(tx, { tenantId, userId: op.userId, action: 'operation.needs_repair', resourceType: 'operation', resourceId: operationId, result: 'failure', metadata: { reason } });
      return row;
    });
  }

  /**
   * Operator replay (runbook): put a needs_repair/failed operation back to pending so the CRM
   * worker resumes ONLY the missing steps. Steps already committed are never repeated.
   */
  async reopen(tenantId: string, operationId: string, actor: string): Promise<OperationRow | null> {
    return this.db.tenantTx(tenantId, async (tx) => {
      const [op] = await tx.select().from(operations).where(eq(operations.id, operationId)).for('update');
      if (!op || !['needs_repair', 'failed'].includes(op.state)) return null;
      const steps = (op.steps as OperationStep[]).map((s) => (s.status === 'failed' ? { ...s, status: 'pending' as const, error: undefined } : s));
      const [row] = await tx.update(operations).set({ state: 'pending', steps, leaseOwner: null, leaseUntil: null, errorInfo: null, retryCount: 0, updatedAt: new Date() }).where(eq(operations.id, operationId)).returning();
      if (op.draftId) await tx.update(drafts).set({ state: 'committing', updatedAt: new Date() }).where(and(eq(drafts.id, op.draftId), eq(drafts.state, 'needs_repair')));
      await this.audit.writeTx(tx, { tenantId, userId: op.userId, action: 'operation.reopened', resourceType: 'operation', resourceId: operationId, metadata: { actor } });
      return row;
    });
  }

  /** "What was saved and what is retrying" for employee replies (CAP-08). */
  static describeProgress(op: Pick<OperationRow, 'steps'>): { saved: string[]; pending: string[]; failed: string[] } {
    const steps = op.steps as OperationStep[];
    const label = (s: OperationStep) => describeStep(s);
    const unique = (xs: string[]) => [...new Set(xs)];
    return {
      saved: unique(steps.filter((s) => s.status === 'committed').map(label)),
      pending: unique(steps.filter((s) => s.status === 'pending' || s.status === 'in_progress').map(label)),
      failed: unique(steps.filter((s) => s.status === 'failed').map(label)),
    };
  }
}
