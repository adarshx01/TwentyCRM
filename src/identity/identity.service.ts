import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createHash, randomInt } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DbService } from '../database/db.service';
import { channelBindings, conversationSessions, drafts, enrollments, schedules, tenants, users } from '../database/schema';
import { toTenantContext } from '../tenant/tenant.service';
import type { ChannelName, TenantContext, UserContext } from '../common/types';
import { AuditService } from '../audit/audit.service';
import { UserFacingError } from '../common/errors';

export interface ResolvedIdentity {
  tenant: TenantContext;
  user: UserContext;
  bindingId: string;
  lastInboundAt: Date | null;
  optedOut: boolean;
  conversationRef: unknown;
}

export type InboundResolution =
  | { kind: 'unknown' }
  | { kind: 'resolved'; identity: ResolvedIdentity }
  | { kind: 'choose'; options: Array<{ tenantId: string; tenantName: string }> };

export interface ChannelKey {
  channel: string;
  connectionId: string;
  externalId: string;
}

type UserRow = typeof users.$inferSelect;

export function toUserContext(u: UserRow, tenantTz: string): UserContext {
  return {
    userId: u.id,
    tenantId: u.tenantId,
    displayName: u.displayName,
    role: u.role,
    teamId: u.teamId ?? undefined,
    managedTeamIds: u.managedTeamIds ?? [],
    twentyMemberId: u.twentyMemberId ?? undefined,
    timezone: u.timezone ?? tenantTz,
    morningReminderTime: u.morningReminderTime ?? undefined,
    preferredReminderChannel: u.preferredReminderChannel ?? undefined,
    dualDelivery: u.dualDelivery,
  };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const ENROLL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newEnrollmentCode(): string {
  const part = () => Array.from({ length: 4 }, () => ENROLL_ALPHABET[randomInt(ENROLL_ALPHABET.length)]).join('');
  return `BEE-${part()}-${part()}`;
}

/**
 * Identity binding and membership (IAM-01..IAM-05).
 * Tenant scope is derived only from verified channel bindings and enrollments.
 */
@Injectable()
export class IdentityService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Resolve an authenticated channel sender to (tenant, user). Never trusts text content (IAM-03). */
  async resolveInbound(key: ChannelKey): Promise<InboundResolution> {
    const rows = await this.db.systemTx((tx) =>
      tx
        .select({ b: channelBindings, u: users, t: tenants })
        .from(channelBindings)
        .innerJoin(users, eq(users.id, channelBindings.userId))
        .innerJoin(tenants, eq(tenants.id, channelBindings.tenantId))
        .where(
          and(
            eq(channelBindings.channel, key.channel),
            eq(channelBindings.connectionId, key.connectionId),
            eq(channelBindings.externalId, key.externalId),
            eq(channelBindings.status, 'active'),
            eq(users.status, 'active'),
            isNull(users.revokedAt),
            eq(tenants.status, 'active'),
          ),
        ),
    );
    if (rows.length === 0) return { kind: 'unknown' };

    const toIdentity = (r: (typeof rows)[number]): ResolvedIdentity => {
      const tenant = toTenantContext(r.t, this.config.twenty.apiUrl);
      return {
        tenant,
        user: toUserContext(r.u, r.t.timezone),
        bindingId: r.b.id,
        lastInboundAt: r.b.lastInboundAt,
        optedOut: r.b.optedOut,
        conversationRef: r.b.conversationRef,
      };
    };
    if (rows.length === 1) return { kind: 'resolved', identity: toIdentity(rows[0]) };

    const [session] = await this.db.systemTx((tx) =>
      tx.select().from(conversationSessions).where(and(eq(conversationSessions.channel, key.channel), eq(conversationSessions.connectionId, key.connectionId), eq(conversationSessions.externalId, key.externalId))),
    );
    const active = session?.activeTenantId && rows.find((r) => r.t.id === session.activeTenantId);
    if (active) return { kind: 'resolved', identity: toIdentity(active) };
    return { kind: 'choose', options: rows.map((r) => ({ tenantId: r.t.id, tenantName: r.t.name })) };
  }

  /** All active memberships of a verified channel identity (IAM-04). */
  async listMemberships(key: ChannelKey): Promise<Array<{ tenantId: string; tenantName: string }>> {
    const rows = await this.db.systemTx((tx) =>
      tx.select({ id: tenants.id, name: tenants.name }).from(channelBindings).innerJoin(users, eq(users.id, channelBindings.userId)).innerJoin(tenants, eq(tenants.id, channelBindings.tenantId))
        .where(and(eq(channelBindings.channel, key.channel), eq(channelBindings.connectionId, key.connectionId), eq(channelBindings.externalId, key.externalId), eq(channelBindings.status, 'active'), eq(users.status, 'active'), isNull(users.revokedAt), eq(tenants.status, 'active'))),
    );
    return rows.map((r) => ({ tenantId: r.id, tenantName: r.name }));
  }

  /** Forget the active workspace so the next message asks again. */
  async clearActive(key: ChannelKey): Promise<void> {
    await this.upsertSession(key, { activeTenantId: null });
  }

  async findUsersByName(tenantId: string, name: string): Promise<UserContext[]> {
    const rows = await this.db.tenantTx(tenantId, (tx) =>
      tx.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.status, 'active'), isNull(users.revokedAt), sql`lower(${users.displayName}) like ${'%' + name.toLowerCase().replace(/[%_\\]/g, '') + '%'}`)).limit(10),
    );
    return rows.map((u) => toUserContext(u, 'UTC'));
  }

  /** Persist the numbered workspace choice (IAM-04). Choices are re-validated against live memberships. */
  async rememberChoices(key: ChannelKey, tenantIds: string[]): Promise<void> {
    await this.upsertSession(key, { pendingChoices: tenantIds });
  }

  async selectWorkspace(key: ChannelKey, choiceIndex: number): Promise<{ tenantId: string } | null> {
    const [s] = await this.db.systemTx((tx) =>
      tx.select().from(conversationSessions).where(and(eq(conversationSessions.channel, key.channel), eq(conversationSessions.connectionId, key.connectionId), eq(conversationSessions.externalId, key.externalId))),
    );
    const tenantId = s?.pendingChoices?.[choiceIndex - 1];
    if (!tenantId) return null;
    // Only memberships that are still active may be selected.
    const res = await this.resolveInboundForTenant(key, tenantId);
    if (!res) return null;
    await this.upsertSession(key, { activeTenantId: tenantId, pendingChoices: null });
    return { tenantId };
  }

  private async resolveInboundForTenant(key: ChannelKey, tenantId: string): Promise<boolean> {
    const rows = await this.db.systemTx((tx) =>
      tx.select({ id: channelBindings.id }).from(channelBindings).innerJoin(users, eq(users.id, channelBindings.userId)).where(
        and(eq(channelBindings.channel, key.channel), eq(channelBindings.connectionId, key.connectionId), eq(channelBindings.externalId, key.externalId), eq(channelBindings.tenantId, tenantId), eq(channelBindings.status, 'active'), eq(users.status, 'active')),
      ),
    );
    return rows.length > 0;
  }

  private async upsertSession(key: ChannelKey, patch: { activeTenantId?: string | null; pendingChoices?: string[] | null }): Promise<void> {
    await this.db.systemTx((tx) =>
      tx
        .insert(conversationSessions)
        .values({ ...key, activeTenantId: patch.activeTenantId ?? null, pendingChoices: patch.pendingChoices ?? null })
        .onConflictDoUpdate({
          target: [conversationSessions.channel, conversationSessions.connectionId, conversationSessions.externalId],
          set: { ...(patch.activeTenantId !== undefined ? { activeTenantId: patch.activeTenantId } : {}), ...(patch.pendingChoices !== undefined ? { pendingChoices: patch.pendingChoices } : {}), updatedAt: new Date() },
        }),
    );
  }

  async touchInbound(tenantId: string, bindingId: string, conversationRef?: unknown): Promise<void> {
    await this.db.tenantTx(tenantId, (tx) =>
      tx.update(channelBindings).set({ lastInboundAt: new Date(), ...(conversationRef ? { conversationRef: conversationRef as any } : {}) }).where(eq(channelBindings.id, bindingId)),
    );
  }

  /** Authoritative live check used at read, commit and delivery time (IAM-05, ACT-03). */
  async getActiveUser(tenantId: string, userId: string): Promise<{ user: UserContext; tenant: TenantContext } | null> {
    const [r] = await this.db.systemTx((tx) =>
      tx.select({ u: users, t: tenants }).from(users).innerJoin(tenants, eq(tenants.id, users.tenantId)).where(and(eq(users.id, userId), eq(users.tenantId, tenantId), eq(users.status, 'active'), isNull(users.revokedAt), eq(tenants.status, 'active'))),
    );
    if (!r) return null;
    return { user: toUserContext(r.u, r.t.timezone), tenant: toTenantContext(r.t, this.config.twenty.apiUrl) };
  }

  // ── Enrollment (IAM-02) ─────────────────────────────────────

  /** Create an expiring single-use code to be delivered through an authenticated company process. */
  async createEnrollment(input: { tenantId: string; userId: string; channel: 'whatsapp' | 'teams' | 'dev' | 'web'; expectedExternalId?: string; createdBy: string; ttlMinutes?: number }): Promise<{ code: string; expiresAt: Date }> {
    const code = newEnrollmentCode();
    const expiresAt = new Date(Date.now() + (input.ttlMinutes ?? 60) * 60_000);
    await this.db.tenantTx(input.tenantId, async (tx) => {
      const [u] = await tx.select({ id: users.id, status: users.status }).from(users).where(and(eq(users.id, input.userId), eq(users.tenantId, input.tenantId)));
      if (!u || u.status !== 'active') throw new UserFacingError('User not found or inactive', 'USER_INACTIVE');
      await tx.insert(enrollments).values({ tenantId: input.tenantId, userId: input.userId, codeHash: sha256(code), channel: input.channel, expectedExternalId: input.expectedExternalId, createdBy: input.createdBy, expiresAt });
    });
    await this.audit.write({ tenantId: input.tenantId, userId: input.userId, action: 'enrollment.created', resourceType: 'user', resourceId: input.userId, metadata: { channel: input.channel, createdBy: input.createdBy } });
    return { code, expiresAt };
  }

  /** Redeem a code from an authenticated channel sender. Returns null for any invalid code (no detail leak). */
  async redeemEnrollment(code: string, key: ChannelKey, conversationRef?: unknown): Promise<{ tenantId: string; userId: string; tenantName: string } | null> {
    const hash = sha256(code.trim().toUpperCase());
    const claimed = await this.db.systemTx(async (tx) => {
      const [row] = await tx
        .update(enrollments)
        .set({ usedAt: new Date() })
        .where(and(eq(enrollments.codeHash, hash), isNull(enrollments.usedAt), eq(enrollments.channel, key.channel), sql`${enrollments.expiresAt} > now()`, sql`(${enrollments.expectedExternalId} is null or ${enrollments.expectedExternalId} = ${key.externalId})`))
        .returning();
      if (!row) return null;
      const [u] = await tx.select().from(users).where(and(eq(users.id, row.userId), eq(users.status, 'active'), isNull(users.revokedAt)));
      if (!u) return null;
      await tx
        .insert(channelBindings)
        .values({ tenantId: row.tenantId, userId: row.userId, channel: key.channel, connectionId: key.connectionId, externalId: key.externalId, conversationRef: (conversationRef ?? null) as any, enrolledBy: null, lastInboundAt: new Date() })
        .onConflictDoUpdate({ target: [channelBindings.channel, channelBindings.connectionId, channelBindings.externalId, channelBindings.tenantId], set: { userId: row.userId, status: 'active', optedOut: false } });
      const [t] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, row.tenantId));
      return { tenantId: row.tenantId, userId: row.userId, tenantName: t?.name ?? '' };
    });
    if (claimed) {
      await this.audit.write({ tenantId: claimed.tenantId, userId: claimed.userId, channel: key.channel, action: 'enrollment.redeemed', resourceType: 'channel_binding' });
    }
    return claimed;
  }

  /**
   * Bind an in-CRM chat identity. The caller (the Bee app inside Twenty, authenticated by a shared secret) vouches for the
   * Twenty workspace and the member's email; the user must already exist and be active in the tenant that owns that workspace.
   */
  async bindTrusted(input: { twentyWorkspaceId: string; email: string; channel: ChannelName; connectionId: string; externalId: string }): Promise<{ tenantId: string; userId: string } | null> {
    const email = input.email.trim().toLowerCase();
    const row = await this.db.systemTx(async (tx) => {
      const [r] = await tx
        .select({ tenantId: tenants.id, userId: users.id })
        .from(tenants)
        .innerJoin(users, eq(users.tenantId, tenants.id))
        .where(and(eq(tenants.twentyWorkspaceId, input.twentyWorkspaceId), eq(tenants.status, 'active'), sql`lower(${users.email}) = ${email}`, eq(users.status, 'active'), isNull(users.revokedAt)))
        .limit(1);
      if (!r) return null;
      await tx
        .insert(channelBindings)
        .values({ tenantId: r.tenantId, userId: r.userId, channel: input.channel, connectionId: input.connectionId, externalId: input.externalId, enrolledBy: null, lastInboundAt: new Date() })
        .onConflictDoUpdate({ target: [channelBindings.channel, channelBindings.connectionId, channelBindings.externalId, channelBindings.tenantId], set: { userId: r.userId, status: 'active', optedOut: false } });
      return r;
    });
    return row;
  }

  // ── Revocation (IAM-05) ─────────────────────────────────────

  /** Block the user everywhere: bindings, pending drafts and scheduled reminders. */
  async revokeUser(tenantId: string, userId: string, actor: string): Promise<void> {
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx.update(users).set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() }).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
      await tx.update(channelBindings).set({ status: 'revoked' }).where(and(eq(channelBindings.userId, userId), eq(channelBindings.tenantId, tenantId)));
      await tx
        .update(drafts)
        .set({ state: 'cancelled', updatedAt: new Date() })
        .where(and(eq(drafts.userId, userId), eq(drafts.tenantId, tenantId), inArray(drafts.state, ['collecting', 'awaiting_confirmation'])));
      await tx.update(schedules).set({ state: 'skipped', completedAt: new Date(), errorInfo: { reason: 'user_revoked' } }).where(and(eq(schedules.userId, userId), eq(schedules.tenantId, tenantId), inArray(schedules.state, ['pending', 'claimed'])));
    });
    await this.audit.write({ tenantId, userId, action: 'user.revoked', resourceType: 'user', resourceId: userId, metadata: { actor } });
  }

  async changeRole(tenantId: string, userId: string, patch: { role?: UserRow['role']; teamId?: string | null; managedTeamIds?: string[] }, actor: string): Promise<void> {
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx.update(users).set({ ...patch, updatedAt: new Date() }).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
      // Pending confirmations were authorized under the old role; force re-preview (IAM-05).
      await tx
        .update(drafts)
        .set({ state: 'cancelled', updatedAt: new Date() })
        .where(and(eq(drafts.userId, userId), eq(drafts.tenantId, tenantId), inArray(drafts.state, ['collecting', 'awaiting_confirmation'])));
    });
    await this.audit.write({ tenantId, userId, action: 'user.role_changed', resourceType: 'user', resourceId: userId, changedFields: patch as Record<string, unknown>, metadata: { actor } });
  }
}
