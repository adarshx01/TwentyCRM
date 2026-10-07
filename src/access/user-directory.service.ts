import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { DbService, type Tx } from '../database/db.service';
import { channelBindings, teams, users } from '../database/schema';
import { IdentityService } from '../identity/identity.service';
import { AuditService } from '../audit/audit.service';
import { UserFacingError } from '../common/errors';
import { isTenantRole, type TenantRole } from './permissions';

export interface UserInput {
  displayName: string;
  email: string;
  role: TenantRole;
  teamId?: string | null;
  managedTeamIds?: string[];
  timezone?: string | null;
  morningReminderTime?: string | null;
  preferredReminderChannel?: 'whatsapp' | 'teams' | 'web' | null;
}

export type UserPatch = Partial<UserInput>;

export interface DirectoryUser {
  id: string;
  displayName: string;
  email: string | null;
  role: TenantRole;
  teamId: string | null;
  managedTeamIds: string[];
  status: string;
  twentyMemberId: string | null;
  preferredReminderChannel: string | null;
  timezone: string | null;
  morningReminderTime: string | null;
  channels: Array<{ channel: string; status: string; enrolledAt: string }>;
}

const TEAM_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Client-admin user and team management for ONE tenant (§4 "manage users, teams and configuration").
 * Every method runs inside tenantTx (RLS), is audited with the acting principal, and refuses changes that would
 * leave the tenant without an active client admin.
 */
@Injectable()
export class UserDirectoryService {
  constructor(
    private readonly db: DbService,
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
  ) {}

  // ── users ───────────────────────────────────────────────────
  async list(tenantId: string): Promise<DirectoryUser[]> {
    return this.db.tenantTx(tenantId, async (tx) => {
      const rows = await tx.select().from(users).where(eq(users.tenantId, tenantId)).orderBy(asc(users.displayName));
      const bindings = await tx.select({ userId: channelBindings.userId, channel: channelBindings.channel, status: channelBindings.status, enrolledAt: channelBindings.enrolledAt }).from(channelBindings).where(eq(channelBindings.tenantId, tenantId));
      return rows.map((u) => ({
        id: u.id, displayName: u.displayName, email: u.email, role: u.role as TenantRole, teamId: u.teamId, managedTeamIds: u.managedTeamIds ?? [], status: u.status,
        twentyMemberId: u.twentyMemberId, preferredReminderChannel: u.preferredReminderChannel, timezone: u.timezone, morningReminderTime: u.morningReminderTime,
        channels: bindings.filter((b) => b.userId === u.id).map((b) => ({ channel: b.channel, status: b.status, enrolledAt: b.enrolledAt.toISOString() })),
      }));
    });
  }

  async get(tenantId: string, userId: string): Promise<DirectoryUser> {
    const u = (await this.list(tenantId)).find((x) => x.id === userId);
    if (!u) throw new UserFacingError('User not found.', 'NOT_FOUND');
    return u;
  }

  private async assertTeams(tx: Tx, tenantId: string, keys: Array<string | null | undefined>): Promise<void> {
    const wanted = [...new Set(keys.filter((k): k is string => !!k))];
    if (!wanted.length) return;
    const found = await tx.select({ key: teams.key }).from(teams).where(and(eq(teams.tenantId, tenantId), inArray(teams.key, wanted), eq(teams.status, 'active')));
    const missing = wanted.filter((k) => !found.some((f) => f.key === k));
    if (missing.length) throw new UserFacingError(`Unknown team(s): ${missing.join(', ')}. Create the team first.`, 'BAD_TEAM');
  }

  private async activeAdminCount(tx: Tx, tenantId: string, excludingUserId?: string): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(users).where(and(
      eq(users.tenantId, tenantId), eq(users.role, 'client_admin'), eq(users.status, 'active'), isNull(users.revokedAt),
      ...(excludingUserId ? [ne(users.id, excludingUserId)] : []),
    ));
    return r?.n ?? 0;
  }

  async create(tenantId: string, input: UserInput, actor: string): Promise<DirectoryUser> {
    if (!isTenantRole(input.role)) throw new UserFacingError('Unknown role.', 'BAD_ROLE');
    const email = input.email.trim().toLowerCase();
    const id = await this.db.tenantTx(tenantId, async (tx) => {
      await this.assertTeams(tx, tenantId, [input.teamId, ...(input.managedTeamIds ?? [])]);
      const [dupe] = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${email}`));
      if (dupe) throw new UserFacingError('A user with this e-mail already exists in this workspace.', 'USER_CONFLICT');
      const [row] = await tx.insert(users).values({
        tenantId, displayName: input.displayName.trim(), email, role: input.role, teamId: input.teamId ?? null,
        managedTeamIds: input.role === 'manager' ? input.managedTeamIds ?? [] : [], timezone: input.timezone ?? null,
        morningReminderTime: input.morningReminderTime ?? null, preferredReminderChannel: input.preferredReminderChannel ?? null,
      }).returning({ id: users.id });
      await this.audit.writeTx(tx, { tenantId, userId: row.id, action: 'user.created', resourceType: 'user', resourceId: row.id, changedFields: { role: input.role, teamId: input.teamId ?? null }, metadata: { actor } });
      return row.id;
    });
    return this.get(tenantId, id);
  }

  async update(tenantId: string, userId: string, patch: UserPatch, actor: string): Promise<DirectoryUser> {
    if (patch.role !== undefined && !isTenantRole(patch.role)) throw new UserFacingError('Unknown role.', 'BAD_ROLE');
    let accessChanged = false;
    await this.db.tenantTx(tenantId, async (tx) => {
      const [cur] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
      if (!cur) throw new UserFacingError('User not found.', 'NOT_FOUND');
      await this.assertTeams(tx, tenantId, [patch.teamId, ...(patch.managedTeamIds ?? [])]);
      const role = patch.role ?? (cur.role as TenantRole);
      if (cur.role === 'client_admin' && role !== 'client_admin' && cur.status === 'active' && (await this.activeAdminCount(tx, tenantId, userId)) === 0) {
        throw new UserFacingError('This is the last active client admin. Make someone else a client admin first.', 'LAST_ADMIN_FORBIDDEN');
      }
      if (patch.email) {
        const email = patch.email.trim().toLowerCase();
        const [dupe] = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), sql`lower(${users.email}) = ${email}`, ne(users.id, userId)));
        if (dupe) throw new UserFacingError('Another user already has this e-mail.', 'USER_CONFLICT');
      }
      const managed = role === 'manager' ? patch.managedTeamIds ?? cur.managedTeamIds ?? [] : [];
      const next = {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName.trim() } : {}),
        ...(patch.email !== undefined ? { email: patch.email.trim().toLowerCase() } : {}),
        role, managedTeamIds: managed,
        ...(patch.teamId !== undefined ? { teamId: patch.teamId } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.morningReminderTime !== undefined ? { morningReminderTime: patch.morningReminderTime } : {}),
        ...(patch.preferredReminderChannel !== undefined ? { preferredReminderChannel: patch.preferredReminderChannel } : {}),
        updatedAt: new Date(),
      };
      accessChanged = role !== cur.role || (patch.teamId !== undefined && patch.teamId !== cur.teamId) || JSON.stringify([...managed].sort()) !== JSON.stringify([...(cur.managedTeamIds ?? [])].sort());
      await tx.update(users).set(next).where(eq(users.id, userId));
      await this.audit.writeTx(tx, { tenantId, userId, action: accessChanged ? 'user.access_changed' : 'user.updated', resourceType: 'user', resourceId: userId, changedFields: Object.keys(patch), metadata: { actor, role, teamId: next.teamId ?? cur.teamId, managedTeamIds: managed } });
    });
    // Pending confirmations were authorized under the old scope: force a fresh preview (IAM-05).
    if (accessChanged) await this.identity.changeRole(tenantId, userId, {}, actor);
    return this.get(tenantId, userId);
  }

  /** Link a Twenty workspace member to a user. One member ↔ one user per tenant (unique index). */
  async linkMember(tenantId: string, userId: string, memberId: string, actor: string): Promise<DirectoryUser> {
    await this.db.tenantTx(tenantId, async (tx) => {
      const [cur] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
      if (!cur) throw new UserFacingError('User not found.', 'NOT_FOUND');
      const [taken] = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.twentyMemberId, memberId), ne(users.id, userId)));
      if (taken) throw new UserFacingError('That Twenty member is already linked to another user.', 'MEMBER_CONFLICT');
      await tx.update(users).set({ twentyMemberId: memberId, updatedAt: new Date() }).where(eq(users.id, userId));
      await this.audit.writeTx(tx, { tenantId, userId, action: 'user.member_linked', resourceType: 'user', resourceId: userId, metadata: { actor, memberId, previous: cur.twentyMemberId } });
    });
    return this.get(tenantId, userId);
  }

  async unlinkMember(tenantId: string, userId: string, actor: string): Promise<DirectoryUser> {
    await this.db.tenantTx(tenantId, async (tx) => {
      const [cur] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
      if (!cur) throw new UserFacingError('User not found.', 'NOT_FOUND');
      await tx.update(users).set({ twentyMemberId: null, updatedAt: new Date() }).where(eq(users.id, userId));
      // The in-CRM chat binding belonged to that member: it must stop working at once.
      await tx.update(channelBindings).set({ status: 'revoked' }).where(and(eq(channelBindings.userId, userId), eq(channelBindings.channel, 'web')));
      await this.audit.writeTx(tx, { tenantId, userId, action: 'user.member_unlinked', resourceType: 'user', resourceId: userId, metadata: { actor, memberId: cur.twentyMemberId } });
    });
    return this.get(tenantId, userId);
  }

  async revoke(tenantId: string, userId: string, actor: string): Promise<DirectoryUser> {
    await this.db.tenantTx(tenantId, async (tx) => {
      const [cur] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
      if (!cur) throw new UserFacingError('User not found.', 'NOT_FOUND');
      if (cur.role === 'client_admin' && cur.status === 'active' && (await this.activeAdminCount(tx, tenantId, userId)) === 0) {
        throw new UserFacingError('This is the last active client admin and cannot be revoked.', 'LAST_ADMIN_FORBIDDEN');
      }
    });
    await this.identity.revokeUser(tenantId, userId, actor);
    return this.get(tenantId, userId);
  }

  /** Re-activate a revoked user. Channel bindings stay revoked: the employee must enroll again (IAM-02). */
  async reinstate(tenantId: string, userId: string, actor: string): Promise<DirectoryUser> {
    await this.db.tenantTx(tenantId, async (tx) => {
      const [cur] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
      if (!cur) throw new UserFacingError('User not found.', 'NOT_FOUND');
      if (cur.status === 'active') return;
      await tx.update(users).set({ status: 'active', revokedAt: null, updatedAt: new Date() }).where(eq(users.id, userId));
      await this.audit.writeTx(tx, { tenantId, userId, action: 'user.reinstated', resourceType: 'user', resourceId: userId, metadata: { actor } });
    });
    return this.get(tenantId, userId);
  }

  async issueEnrollment(tenantId: string, userId: string, channel: 'whatsapp' | 'teams', actor: string, opts: { expectedExternalId?: string; ttlMinutes?: number } = {}) {
    const r = await this.identity.createEnrollment({ tenantId, userId, channel, expectedExternalId: opts.expectedExternalId, ttlMinutes: opts.ttlMinutes, createdBy: actor });
    return { code: r.code, expiresAt: r.expiresAt.toISOString(), instructions: `The employee sends "${r.code}" to the ${channel === 'whatsapp' ? 'WhatsApp' : 'Teams'} bot from their own account before it expires.` };
  }

  // ── teams ───────────────────────────────────────────────────
  async listTeams(tenantId: string) {
    return this.db.tenantTx(tenantId, async (tx) => {
      const rows = await tx.select().from(teams).where(eq(teams.tenantId, tenantId)).orderBy(asc(teams.name));
      const members = await tx.select({ teamId: users.teamId, managed: users.managedTeamIds, status: users.status }).from(users).where(eq(users.tenantId, tenantId));
      return rows.map((t) => ({
        key: t.key, name: t.name, status: t.status,
        members: members.filter((m) => m.teamId === t.key && m.status === 'active').length,
        managers: members.filter((m) => (m.managed ?? []).includes(t.key) && m.status === 'active').length,
      }));
    });
  }

  async upsertTeam(tenantId: string, key: string, name: string, actor: string) {
    if (!TEAM_KEY.test(key)) throw new UserFacingError('Team keys are lowercase letters, digits, "-" or "_".', 'BAD_TEAM');
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx.insert(teams).values({ tenantId, key, name: name.trim() }).onConflictDoUpdate({ target: [teams.tenantId, teams.key], set: { name: name.trim(), status: 'active', updatedAt: new Date() } });
      await this.audit.writeTx(tx, { tenantId, action: 'team.saved', resourceType: 'team', resourceId: key, metadata: { actor, name } });
    });
    return this.listTeams(tenantId);
  }

  async deactivateTeam(tenantId: string, key: string, actor: string) {
    await this.db.tenantTx(tenantId, async (tx) => {
      const holders = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.status, 'active'), sql`(${users.teamId} = ${key} or ${users.managedTeamIds} ? ${key})`));
      if (holders.length) throw new UserFacingError(`${holders.length} active user(s) still belong to or manage this team. Move them first.`, 'TEAM_IN_USE_CONFLICT');
      await tx.update(teams).set({ status: 'inactive', updatedAt: new Date() }).where(and(eq(teams.tenantId, tenantId), eq(teams.key, key)));
      await this.audit.writeTx(tx, { tenantId, action: 'team.deactivated', resourceType: 'team', resourceId: key, metadata: { actor } });
    });
    return this.listTeams(tenantId);
  }
}
