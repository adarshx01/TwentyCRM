import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { DbService } from '../database/db.service';
import { platformOperators, supportGrants } from '../database/schema';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { AuditService } from '../audit/audit.service';
import { UserFacingError } from '../common/errors';
import { safeEqual } from './app-secret';

/** A platform-plane principal. `bootstrap` is the break-glass ADMIN_API_KEY (used to create named operators). */
export interface OperatorPrincipal {
  id: string;
  name: string;
  kind: 'bootstrap' | 'named';
}

export const operatorActor = (o: OperatorPrincipal) => `operator:${o.kind === 'bootstrap' ? 'bootstrap' : o.id}`;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Platform operators (§4, §8 of docs/access-architecture.md). Operators administer the service. They reach a
 * tenant's customer data only through a support grant that a client admin of THAT tenant approved; every grant
 * decision and every access is written to the tenant's own audit trail, which the client admin can read.
 */
@Injectable()
export class OperatorService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async authenticate(key: string | undefined): Promise<OperatorPrincipal | null> {
    if (!key || key.length < 32) return null;
    if (safeEqual(key, this.config.security.adminApiKey)) return { id: 'bootstrap', name: 'bootstrap', kind: 'bootstrap' };
    const [op] = await this.db.systemTx((tx) => tx.select().from(platformOperators).where(and(eq(platformOperators.keyHash, sha256(key)), eq(platformOperators.status, 'active'))));
    if (!op) return null;
    await this.db.systemTx((tx) => tx.update(platformOperators).set({ lastUsedAt: new Date() }).where(eq(platformOperators.id, op.id)));
    return { id: op.id, name: op.name, kind: 'named' };
  }

  async create(input: { name: string; email: string }, by: OperatorPrincipal): Promise<{ id: string; key: string }> {
    if (by.kind !== 'bootstrap') throw new UserFacingError('Only the bootstrap key can create operators.', 'OPERATOR_FORBIDDEN');
    const key = `op_${randomBytes(32).toString('base64url')}`;
    const [row] = await this.db.systemTx((tx) => tx.insert(platformOperators).values({ name: input.name, email: input.email.toLowerCase(), keyHash: sha256(key), createdBy: operatorActor(by) }).onConflictDoNothing().returning({ id: platformOperators.id }));
    if (!row) throw new UserFacingError('An operator with this e-mail already exists.', 'OPERATOR_CONFLICT');
    return { id: row.id, key };
  }

  async list() {
    return this.db.systemTx((tx) => tx.select({ id: platformOperators.id, name: platformOperators.name, email: platformOperators.email, status: platformOperators.status, lastUsedAt: platformOperators.lastUsedAt, createdAt: platformOperators.createdAt }).from(platformOperators));
  }

  async revoke(id: string, by: OperatorPrincipal): Promise<void> {
    if (by.kind !== 'bootstrap') throw new UserFacingError('Only the bootstrap key can revoke operators.', 'OPERATOR_FORBIDDEN');
    await this.db.systemTx((tx) => tx.update(platformOperators).set({ status: 'revoked', revokedAt: new Date() }).where(eq(platformOperators.id, id)));
  }

  // ── support grants ──────────────────────────────────────────
  async requestSupport(tenantId: string, by: OperatorPrincipal, reason: string, hours: number) {
    if (by.kind !== 'named') throw new UserFacingError('Support access is requested by a named operator, not the bootstrap key.', 'OPERATOR_FORBIDDEN');
    const h = Math.min(Math.max(Math.round(hours), 1), 72);
    const [row] = await this.db.tenantTx(tenantId, async (tx) => {
      const r = await tx.insert(supportGrants).values({ tenantId, operatorId: by.id, reason: reason.slice(0, 2000), hours: h }).returning();
      await this.audit.writeTx(tx, { tenantId, action: 'support.requested', resourceType: 'support_grant', resourceId: r[0].id, metadata: { actor: operatorActor(by), operator: by.name, reason, hours: h } });
      return r;
    });
    return row;
  }

  async listGrants(tenantId: string) {
    return this.db.tenantTx(tenantId, async (tx) => {
      const rows = await tx.select().from(supportGrants).where(eq(supportGrants.tenantId, tenantId)).orderBy(desc(supportGrants.createdAt)).limit(50);
      const ops = await this.db.systemTx((s) => s.select({ id: platformOperators.id, name: platformOperators.name, email: platformOperators.email }).from(platformOperators));
      return rows.map((g) => ({ ...g, effectiveState: g.state === 'active' && g.expiresAt && g.expiresAt <= new Date() ? 'expired' : g.state, operator: ops.find((o) => o.id === g.operatorId) ?? null }));
    });
  }

  /** Client admin decision. Approval starts the clock; denial and revocation are immediate. */
  async decide(tenantId: string, grantId: string, decision: 'approve' | 'deny' | 'revoke', byUserId: string) {
    return this.db.tenantTx(tenantId, async (tx) => {
      const [g] = await tx.select().from(supportGrants).where(and(eq(supportGrants.id, grantId), eq(supportGrants.tenantId, tenantId))).for('update');
      if (!g) throw new UserFacingError('Support request not found.', 'NOT_FOUND');
      if (decision === 'revoke') {
        if (g.state !== 'active') throw new UserFacingError('Only active access can be ended.', 'BAD_STATE');
        await tx.update(supportGrants).set({ state: 'revoked', decidedBy: byUserId, decidedAt: new Date() }).where(eq(supportGrants.id, grantId));
      } else {
        if (g.state !== 'requested') throw new UserFacingError('This request was already decided.', 'BAD_STATE');
        const approve = decision === 'approve';
        await tx.update(supportGrants).set({ state: approve ? 'active' : 'denied', decidedBy: byUserId, decidedAt: new Date(), expiresAt: approve ? new Date(Date.now() + g.hours * 3_600_000) : null }).where(eq(supportGrants.id, grantId));
      }
      await this.audit.writeTx(tx, { tenantId, userId: byUserId, action: `support.${decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'revoked'}`, resourceType: 'support_grant', resourceId: grantId, metadata: { actor: `user:${byUserId}`, operatorId: g.operatorId } });
      const [after] = await tx.select().from(supportGrants).where(eq(supportGrants.id, grantId));
      return after;
    });
  }

  /** Throws unless the operator holds an active, unexpired grant for the tenant. Every successful check is audited. */
  async requireGrant(tenantId: string, by: OperatorPrincipal, purpose: string): Promise<void> {
    const [g] = by.kind === 'named'
      ? await this.db.tenantTx(tenantId, (tx) => tx.select().from(supportGrants).where(and(eq(supportGrants.tenantId, tenantId), eq(supportGrants.operatorId, by.id), eq(supportGrants.state, 'active'), gt(supportGrants.expiresAt, new Date()))).limit(1))
      : [];
    if (!g) {
      await this.audit.write({ tenantId, action: 'support.access_denied', resourceType: 'support_grant', result: 'denied', metadata: { actor: operatorActor(by), purpose } });
      throw new UserFacingError('Customer data needs a support grant approved by a client admin of this workspace.', 'SUPPORT_GRANT_FORBIDDEN');
    }
    await this.audit.write({ tenantId, action: 'support.access', resourceType: 'support_grant', resourceId: g.id, metadata: { actor: operatorActor(by), purpose } });
  }

  /** Active grant ids per tenant, for redaction decisions in bulk listings. */
  async activeTenantGrants(by: OperatorPrincipal): Promise<Set<string>> {
    if (by.kind !== 'named') return new Set();
    const rows = await this.db.systemTx((tx) => tx.select({ tenantId: supportGrants.tenantId }).from(supportGrants).where(and(eq(supportGrants.operatorId, by.id), eq(supportGrants.state, 'active'), gt(supportGrants.expiresAt, new Date()))));
    return new Set(rows.map((r) => r.tenantId));
  }
}
