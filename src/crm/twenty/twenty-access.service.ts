import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { TenantContext } from '../../common/types';
import { DbService } from '../../database/db.service';
import { users } from '../../database/schema';
import { AuditService } from '../../audit/audit.service';
import { CRM_ADAPTER, type CrmAdapter } from '../crm-adapter.interface';
import { FETCH_FN, TwentyClient } from './twenty-client';
import { SECRET_RESOLVER, type SecretResolver } from '../../secrets/secret-resolver';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { TWENTY_ROLE_LABELS, isTenantRole } from '../../access/permissions';
import { getLogger } from '../../observability/logger';

type RoleSpec = {
  canReadAllObjectRecords: boolean;
  canUpdateAllObjectRecords: boolean;
  canSoftDeleteAllObjectRecords: boolean;
  canDestroyAllObjectRecords: boolean;
  canUpdateAllSettings: boolean;
  canAccessAllTools: boolean;
  canBeAssignedToUsers: boolean;
  canBeAssignedToApiKeys?: boolean;
  flags: string[];
};

const NONE: RoleSpec = { canReadAllObjectRecords: false, canUpdateAllObjectRecords: false, canSoftDeleteAllObjectRecords: false, canDestroyAllObjectRecords: false, canUpdateAllSettings: false, canAccessAllTools: false, canBeAssignedToUsers: true, flags: [] };

/**
 * Native Twenty roles Bee manages in every workspace (docs/access-architecture.md §3, decision A1).
 * Without a Twenty Organization key Twenty cannot limit a role to "own records", so salespeople and managers get NO
 * direct record access: they use Ask AI › Bee (the AI flag), WhatsApp and Teams, where Bee enforces their scope.
 * Nobody but the native Admin may permanently destroy records (§4).
 */
export const BEE_TWENTY_ROLES: Record<Exclude<keyof typeof TWENTY_ROLE_LABELS, 'client_admin'>, { label: string; description: string; spec: RoleSpec }> = {
  none: { label: TWENTY_ROLE_LABELS.none, description: 'Managed by CRM Bee: no access (unlinked or revoked members).', spec: NONE },
  salesperson: { label: TWENTY_ROLE_LABELS.salesperson, description: 'Managed by CRM Bee: works through Ask AI › Bee; Bee limits records to their own.', spec: { ...NONE, flags: ['AI'] } },
  manager: { label: TWENTY_ROLE_LABELS.manager, description: 'Managed by CRM Bee: works through Ask AI › Bee; Bee limits records to own + assigned teams.', spec: { ...NONE, flags: ['AI'] } },
  cxo: {
    label: TWENTY_ROLE_LABELS.cxo, description: 'Managed by CRM Bee: all records of the company; no settings; no permanent delete.',
    spec: { ...NONE, canReadAllObjectRecords: true, canUpdateAllObjectRecords: true, canSoftDeleteAllObjectRecords: true, flags: ['AI', 'EXPORT_CSV', 'IMPORT_CSV', 'UPLOAD_FILE', 'DOWNLOAD_FILE', 'VIEWS'] },
  },
};

/**
 * The workspace service key (Integration Service Identity, §4): reads and writes CRM records and provisions Bee's
 * schema, but cannot permanently destroy records, manage roles/members/settings, or install apps. It is NOT an
 * administrator and does not stand in for an employee: Bee applies the employee's scope to every call it makes.
 */
export const INTEGRATION_ROLE = {
  label: 'Bee · Integration',
  description: 'Managed by CRM Bee: service identity for the Bee integration key. Records and schema only; no destroy, roles or settings.',
  spec: { canReadAllObjectRecords: true, canUpdateAllObjectRecords: true, canSoftDeleteAllObjectRecords: true, canDestroyAllObjectRecords: false, canUpdateAllSettings: false, canAccessAllTools: false, canBeAssignedToUsers: false, canBeAssignedToApiKeys: true, flags: ['DATA_MODEL'] } as RoleSpec & { canBeAssignedToApiKeys: boolean },
};

export interface AccessSyncReport {
  ok: boolean;
  rolesCreated: string[];
  rolesUpdated: string[];
  workspaceSettingsChanged: string[];
  /** Settings Bee could not change with its service key (see scripts/twenty-harden.mjs) */
  workspaceSettingsPending?: string[];
  memberChanges: Array<{ memberId: string; email: string | null; from: string | null; to: string }>;
  /** Members linked automatically because they accepted a Bee invitation */
  autoLinked?: string[];
  /** The integration key's Twenty role after the sync (Bee · Integration when the service user is configured) */
  integrationRole?: { keyId: string; role: string; changed: boolean };
  drift: string[];
  error?: string;
}

interface TwentyRole { id: string; label: string; isEditable: boolean; workspaceMembers: Array<{ id: string; userEmail?: string }>; permissionFlags: Array<{ flag: string }> & unknown[]; [k: string]: unknown }

/**
 * Keeps a tenant's Twenty roles, default role, invite/impersonation settings and member role assignments in line with
 * Bee, which is the source of truth for roles (decision A6). Runs at provisioning, after every user change, and from
 * reconciliation every few minutes so a change made natively in Twenty is re-applied and reported as drift (IAM-05).
 */
@Injectable()
export class TwentyAccessService {
  private readonly log = getLogger('twenty-access');

  constructor(
    private readonly client: TwentyClient,
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
    @Inject(FETCH_FN) private readonly fetchFn: typeof fetch,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private readonly sessions = new Map<string, { token: string; until: number }>();
  private readonly adoptionChecked = new Map<string, number>();

  /**
   * A person who just accepted the invitation a client admin sent through Bee is linked right away (same mailbox, invited
   * by Bee), instead of waiting for the next reconciliation. Returns true when the member is now linked.
   */
  async adoptAcceptedInvitation(ctx: TenantContext, memberId: string): Promise<boolean> {
    const key = `${ctx.tenantId}:${memberId}`;
    const now = Date.now();
    if ((this.adoptionChecked.get(key) ?? 0) > now - 15_000) return false;
    this.adoptionChecked.set(key, now);
    if (this.adoptionChecked.size > 5000) this.adoptionChecked.clear();
    const members = await this.crm.listWorkspaceMembers(ctx).catch(() => []);
    const member = members.find((m) => m.id === memberId);
    if (!member?.email) return false;
    const rows = await this.db.tenantTx(ctx.tenantId, (tx) => tx.select({ id: users.id, member: users.twentyMemberId, email: users.email, invitedAt: users.twentyInvitedAt, status: users.status }).from(users).where(eq(users.tenantId, ctx.tenantId)));
    if (rows.some((u) => u.member === memberId)) return true;
    const u = rows.find((x) => !x.member && !!x.invitedAt && x.status === 'active' && x.email?.toLowerCase() === member.email!.toLowerCase());
    if (!u) return false;
    await this.db.tenantTx(ctx.tenantId, async (tx) => {
      await tx.update(users).set({ twentyMemberId: memberId, updatedAt: new Date() }).where(eq(users.id, u.id));
      await this.audit.writeTx(tx, { tenantId: ctx.tenantId, userId: u.id, action: 'user.member_linked', resourceType: 'user', resourceId: u.id, metadata: { actor: 'system:invitation-accepted', memberId } });
    });
    void this.sync(ctx).catch((e) => this.log.warn({ tenantId: ctx.tenantId, err: (e as Error).message }, 'role sync after invitation failed'));
    return true;
  }

  /** Id of the workspace service key = the `jti` claim of its JWT. */
  private async keyId(ctx: TenantContext): Promise<string | null> {
    try {
      const token = await this.secrets.resolve(ctx.twentyApiTokenRef);
      const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { jti?: string };
      return payload.jti ?? null;
    } catch { return null; }
  }

  /**
   * Role/app/settings operations run as the Bee service user when one is configured (Twenty refuses several of them
   * to API keys, and the key is deliberately NOT an administrator); otherwise as the workspace key.
   */
  private async gql<T = any>(ctx: TenantContext, query: string, variables: Record<string, unknown> = {}, bearer?: string): Promise<T> {
    let token = bearer;
    if (!token) token = (await this.serviceSession(ctx).catch(() => null)) ?? undefined;
    const res = await this.client.request(ctx, { method: 'POST', path: '/metadata', body: { query, variables }, bearer: token });
    if (res?.errors?.length) throw new Error(`Twenty GraphQL: ${String(res.errors[0]?.message ?? 'error').slice(0, 200)}`);
    return res?.data as T;
  }

  /**
   * Session of the tenant's Bee service user. Twenty accepts member-role assignment and workspace settings only from a
   * signed-in user, never from an API key or an app; this service identity (an Admin seat) is used for exactly that.
   */
  private async serviceSession(ctx: TenantContext): Promise<string | null> {
    const su = ctx.settings.twentyServiceUser;
    if (!su) return null;
    const hit = this.sessions.get(ctx.tenantId);
    if (hit && hit.until > Date.now()) return hit.token;
    const base = (ctx.twentyBaseUrl ?? this.config.twenty.apiUrl).replace(/\/$/, '');
    const call = async (query: string, variables: Record<string, unknown>) => {
      const r = await this.fetchFn(`${base}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(this.config.twenty.timeoutMs * 2) });
      const j = (await r.json()) as { data?: any; errors?: Array<{ message: string }> };
      if (j.errors?.length) throw new Error(`Twenty sign-in: ${j.errors[0].message}`);
      return j.data;
    };
    const password = await this.secrets.resolve(su.passwordRef);
    const login = await call(`mutation($e:String!,$p:String!,$o:String!){ getLoginTokenFromCredentials(email:$e,password:$p,origin:$o){ loginToken { token } } }`, { e: su.email, p: password, o: base });
    const tokens = await call(`mutation($t:String!,$o:String!){ getAuthTokensFromLoginToken(loginToken:$t,origin:$o){ tokens { accessOrWorkspaceAgnosticToken { token expiresAt } } } }`, { t: login.getLoginTokenFromCredentials.loginToken.token, o: base });
    const t = tokens.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken;
    const until = Math.min(new Date(t.expiresAt).getTime() - 60_000, Date.now() + 15 * 60_000);
    this.sessions.set(ctx.tenantId, { token: t.token, until });
    return t.token;
  }

  private getRoles(ctx: TenantContext): Promise<TwentyRole[]> {
    return this.gql<{ getRoles: TwentyRole[] }>(ctx, `{ getRoles { id label isEditable canReadAllObjectRecords canUpdateAllObjectRecords canSoftDeleteAllObjectRecords canDestroyAllObjectRecords canUpdateAllSettings canAccessAllTools canBeAssignedToUsers canBeAssignedToApiKeys workspaceMembers { id userEmail } permissionFlags { flag } } }`).then((d) => d.getRoles);
  }

  async sync(ctx: TenantContext, opts: { dryRun?: boolean } = {}): Promise<AccessSyncReport> {
    const report: AccessSyncReport = { ok: true, rolesCreated: [], rolesUpdated: [], workspaceSettingsChanged: [], memberChanges: [], drift: [] };
    try {
      let roles = await this.getRoles(ctx);
      const byLabel = (l: string) => roles.find((r) => r.label === l);

      // 1. Bee-managed roles exist with exactly the intended permissions.
      for (const def of Object.values(BEE_TWENTY_ROLES)) {
        const { flags, ...spec } = def.spec;
        let role = byLabel(def.label);
        if (!role) {
          if (opts.dryRun) { report.rolesCreated.push(def.label); continue; }
          await this.gql(ctx, `mutation($i: CreateRoleInput!) { createOneRole(createRoleInput: $i) { id } }`, { i: { label: def.label, description: def.description, icon: 'IconShieldLock', ...spec } });
          report.rolesCreated.push(def.label);
          roles = await this.getRoles(ctx);
          role = byLabel(def.label)!;
        } else if (Object.entries(spec).some(([k, v]) => role![k] !== v)) {
          report.drift.push(`role "${def.label}" permissions differed from Bee's definition`);
          if (!opts.dryRun) await this.gql(ctx, `mutation($i: UpdateRoleInput!) { updateOneRole(updateRoleInput: $i) { id } }`, { i: { id: role.id, update: { description: def.description, ...spec } } });
          report.rolesUpdated.push(def.label);
        }
        const have = new Set((role.permissionFlags ?? []).map((f) => f.flag));
        if (flags.length !== have.size || flags.some((f) => !have.has(f))) {
          if (!opts.dryRun) await this.gql(ctx, `mutation($i: UpsertPermissionFlagsInput!) { upsertPermissionFlags(upsertPermissionFlagsInput: $i) { id } }`, { i: { roleId: role.id, permissionFlagKeys: flags } });
          if (!report.rolesUpdated.includes(def.label) && !report.rolesCreated.includes(def.label)) report.rolesUpdated.push(def.label);
        }
      }
      if (report.rolesCreated.length || report.rolesUpdated.length) roles = opts.dryRun ? roles : await this.getRoles(ctx);
      const admin = roles.find((r) => r.label === TWENTY_ROLE_LABELS.client_admin && !r.isEditable) ?? byLabel(TWENTY_ROLE_LABELS.client_admin);
      const noAccess = byLabel(TWENTY_ROLE_LABELS.none);

      // 1b. Integration identity: the key gets the dedicated role instead of Admin (only when a session can assign it,
      //     so a missing/incorrect service user can never lock Bee out of its own workspace).
      {
        const { flags, ...ispec } = INTEGRATION_ROLE.spec;
        let role = byLabel(INTEGRATION_ROLE.label);
        if (!role && !opts.dryRun) {
          await this.gql(ctx, `mutation($i: CreateRoleInput!) { createOneRole(createRoleInput: $i) { id } }`, { i: { label: INTEGRATION_ROLE.label, description: INTEGRATION_ROLE.description, icon: 'IconPlugConnected', ...ispec } });
          report.rolesCreated.push(INTEGRATION_ROLE.label);
          roles = await this.getRoles(ctx);
          role = byLabel(INTEGRATION_ROLE.label);
        } else if (role && Object.entries(ispec).some(([k, v]) => (role as any)[k] !== v)) {
          report.drift.push(`role "${INTEGRATION_ROLE.label}" permissions differed from Bee's definition`);
          if (!opts.dryRun) await this.gql(ctx, `mutation($i: UpdateRoleInput!) { updateOneRole(updateRoleInput: $i) { id } }`, { i: { id: role.id, update: { description: INTEGRATION_ROLE.description, ...ispec } } });
          report.rolesUpdated.push(INTEGRATION_ROLE.label);
        }
        if (role) {
          const have = new Set((role.permissionFlags ?? []).map((f) => f.flag));
          if (flags.length !== have.size || flags.some((f) => !have.has(f))) {
            if (!opts.dryRun) await this.gql(ctx, `mutation($i: UpsertPermissionFlagsInput!) { upsertPermissionFlags(upsertPermissionFlagsInput: $i) { id } }`, { i: { roleId: role.id, permissionFlagKeys: flags } });
          }
          const session = await this.serviceSession(ctx).catch(() => null);
          const keyId = await this.keyId(ctx);
          if (session && keyId) {
            const keys = await this.gql<{ apiKeys: Array<{ id: string; role: { label: string } | null }> }>(ctx, `{ apiKeys { id role { label } } }`, {}, session);
            const cur = keys.apiKeys.find((k) => k.id === keyId)?.role?.label ?? null;
            const changed = cur !== INTEGRATION_ROLE.label;
            report.integrationRole = { keyId, role: INTEGRATION_ROLE.label, changed };
            if (changed) {
              report.drift.push(`integration key had role "${cur ?? 'none'}"`);
              if (!opts.dryRun) await this.gql(ctx, `mutation($k: UUID!, $r: UUID!) { assignRoleToApiKey(apiKeyId: $k, roleId: $r) }`, { k: keyId, r: role.id }, session);
            }
          }
        }
      }

      // 2. Workspace settings: new joiners get NO access until a client admin links them; no public invite link;
      //    no impersonation (operator access to customer data goes through support grants, §4).
      const ws = await this.gql<{ currentWorkspace: { id: string; defaultRole: { id: string } | null; isPublicInviteLinkEnabled: boolean; allowImpersonation: boolean } }>(ctx, `{ currentWorkspace { id defaultRole { id } isPublicInviteLinkEnabled allowImpersonation } }`);
      if (ws.currentWorkspace.id !== ctx.twentyWorkspaceId) throw new Error('The service key belongs to a different Twenty workspace than this tenant.');
      const wsPatch: Record<string, unknown> = {};
      if (noAccess && ws.currentWorkspace.defaultRole?.id !== noAccess.id) wsPatch.defaultRoleId = noAccess.id;
      if (ws.currentWorkspace.isPublicInviteLinkEnabled) wsPatch.isPublicInviteLinkEnabled = false;
      if (ws.currentWorkspace.allowImpersonation) wsPatch.allowImpersonation = false;
      if (Object.keys(wsPatch).length) {
        // Twenty accepts workspace settings only from a signed-in admin session, not from an API key. When refused,
        // the gap is reported (scripts/twenty-harden.mjs closes it once); member roles below are still enforced, so an
        // unlinked joiner is moved to "No access" on the next sync even while the default role is wrong.
        try {
          if (!opts.dryRun) {
            const session = await this.serviceSession(ctx);
            if (!session) throw new Error('no service user');
            await this.gql(ctx, `mutation($d: UpdateWorkspaceInput!) { updateWorkspace(data: $d) { id } }`, { d: wsPatch }, session);
          }
          report.workspaceSettingsChanged.push(...Object.keys(wsPatch));
        } catch (e) {
          report.workspaceSettingsPending = Object.keys(wsPatch);
          report.drift.push(`workspace settings need a Twenty user session (configure the Bee service user, or run scripts/twenty-harden.mjs): ${Object.keys(wsPatch).join(', ')} [${(e as Error).message}]`);
        }
      }

      // 3. Member → role assignments follow Bee.
      const members = await this.crm.listWorkspaceMembers(ctx);
      const beeUsers = await this.db.tenantTx(ctx.tenantId, (tx) => tx.select({ id: users.id, role: users.role, status: users.status, member: users.twentyMemberId, email: users.email, invitedAt: users.twentyInvitedAt }).from(users).where(eq(users.tenantId, ctx.tenantId)));
      // A member that accepted OUR invitation (same mailbox, invited by a client admin through Bee) is linked to that user.
      const linkedIds = new Set(beeUsers.map((u) => u.member).filter(Boolean));
      for (const u of beeUsers) {
        if (u.member || !u.invitedAt || u.status !== 'active' || !u.email) continue;
        const m = members.find((x) => x.email?.toLowerCase() === u.email!.toLowerCase() && !linkedIds.has(x.id));
        if (!m) continue;
        report.autoLinked = [...(report.autoLinked ?? []), u.email];
        if (opts.dryRun) continue;
        await this.db.tenantTx(ctx.tenantId, async (tx) => {
          await tx.update(users).set({ twentyMemberId: m.id, updatedAt: new Date() }).where(eq(users.id, u.id));
          await this.audit.writeTx(tx, { tenantId: ctx.tenantId, userId: u.id, action: 'user.member_linked', resourceType: 'user', resourceId: u.id, metadata: { actor: 'system:invitation-accepted', memberId: m.id } });
        });
        u.member = m.id; linkedIds.add(m.id);
      }
      const currentRole = (memberId: string) => roles.find((r) => r.workspaceMembers?.some((m) => m.id === memberId)) ?? null;
      const linkedActiveAdmins = beeUsers.filter((u) => u.role === 'client_admin' && u.status === 'active' && u.member && members.some((m) => m.id === u.member));
      let adminSeats = members.filter((m) => currentRole(m.id)?.id === admin?.id).length;

      const serviceEmail = ctx.settings.twentyServiceUser?.email.toLowerCase();
      let session: string | null | undefined;
      for (const m of members) {
        if (serviceEmail && m.email?.toLowerCase() === serviceEmail) continue; // Bee's own service identity keeps its Admin seat
        const u = beeUsers.find((x) => x.member === m.id);
        const desiredLabel = u && u.status === 'active' && isTenantRole(u.role) ? TWENTY_ROLE_LABELS[u.role] : TWENTY_ROLE_LABELS.none;
        const desired = desiredLabel === TWENTY_ROLE_LABELS.client_admin ? admin : byLabel(desiredLabel);
        const cur = currentRole(m.id);
        if (!u) report.drift.push(`${m.email ?? m.id} is a Twenty member without a linked Bee user`);
        if (!desired || cur?.id === desired.id) continue;
        if (cur?.id === admin?.id) {
          // Never lock the workspace out: keep the last Admin, and keep unlinked Admins until a client admin is linked.
          if (adminSeats <= 1) { report.drift.push(`${m.email ?? m.id} keeps Admin: it is the last Admin seat`); continue; }
          if (!u && !linkedActiveAdmins.length) { report.drift.push(`${m.email ?? m.id} keeps Admin until a client admin is linked in Bee`); continue; }
          adminSeats--;
        }
        if (desired.id === admin?.id) adminSeats++;
        report.memberChanges.push({ memberId: m.id, email: m.email, from: cur?.label ?? null, to: desired.label });
        if (!opts.dryRun) {
          session ??= await this.serviceSession(ctx);
          if (!session) { report.drift.push(`${m.email ?? m.id} should be "${desired.label}": configure the Bee service user so Bee can assign Twenty roles`); continue; }
          await this.gql(ctx, `mutation($m: UUID!, $r: UUID!) { updateWorkspaceMemberRole(workspaceMemberId: $m, roleId: $r) { id } }`, { m: m.id, r: desired.id }, session);
        }
      }
      if (!opts.dryRun && (report.memberChanges.length || report.rolesCreated.length || report.rolesUpdated.length || report.workspaceSettingsChanged.length)) {
        await this.audit.write({ tenantId: ctx.tenantId, action: 'twenty.access_synced', resourceType: 'tenant', resourceId: ctx.tenantId, metadata: { ...report } });
      }
    } catch (e) {
      report.ok = false;
      report.error = (e as Error).message;
      this.log.warn({ tenantId: ctx.tenantId, err: report.error }, 'twenty access sync failed');
    }
    return report;
  }

  /**
   * Invite an employee's e-mail into the Twenty workspace (Twenty e-mails them a personal link). They join as
   * "Bee · No access" until Bee links them to their user; the admin's invitation is what attests the mailbox.
   */
  async inviteMember(ctx: TenantContext, email: string): Promise<{ sent: boolean; error?: string }> {
    try {
      const session = await this.serviceSession(ctx);
      if (!session) return { sent: false, error: "Bee's Twenty service user is not configured for this workspace." };
      const roles = await this.getRoles(ctx);
      const noAccess = roles.find((r) => r.label === TWENTY_ROLE_LABELS.none);
      const r = await this.gql<{ sendInvitations: { success: boolean; errors: string[] } }>(
        ctx,
        `mutation($e: [String!]!, $r: UUID) { sendInvitations(emails: $e, roleId: $r) { success errors } }`,
        { e: [email], r: noAccess?.id ?? null },
        session,
      );
      return r.sendInvitations.success ? { sent: true } : { sent: false, error: r.sendInvitations.errors.join('; ') || 'Twenty did not send the invitation.' };
    } catch (e) {
      return { sent: false, error: (e as Error).message };
    }
  }

  /** Tenant secret + Bee URL for the CRM Bee app installed in the workspace (skipped when the app is absent). */
  async configureApp(ctx: TenantContext, vars: Record<string, string>): Promise<{ configured: boolean; reason?: string }> {
    try {
      const apps = await this.gql<{ findManyApplications: Array<{ id: string; name: string }> }>(ctx, `{ findManyApplications { id name } }`);
      const app = apps.findManyApplications.find((a) => a.name === 'CRM Bee');
      if (!app) return { configured: false, reason: 'CRM Bee app is not installed in this workspace' };
      for (const [k, v] of Object.entries(vars)) {
        await this.gql(ctx, `mutation($k: String!, $v: String!, $a: UUID) { updateOneApplicationVariable(key: $k, value: $v, applicationId: $a) }`, { k, v, a: app.id });
      }
      return { configured: true };
    } catch (e) {
      return { configured: false, reason: (e as Error).message };
    }
  }

  /** Move this workspace's CRM Bee app to the newest version published on the Twenty instance (Twenty's upgradeApplication). */
  async upgradeApp(ctx: TenantContext): Promise<{ upgraded: boolean; from?: string; to?: string; reason?: string }> {
    try {
      const apps = await this.gql<{ findManyApplications: Array<{ id: string; name: string; version: string | null; universalIdentifier: string; applicationRegistrationId: string | null }> }>(ctx, `{ findManyApplications { id name version universalIdentifier applicationRegistrationId } }`);
      const app = apps.findManyApplications.find((a) => a.name === 'CRM Bee');
      if (!app?.applicationRegistrationId) return { upgraded: false, reason: 'CRM Bee is not installed from the instance registry in this workspace' };
      // The registration belongs to the platform workspace, so it is found by its universal identifier, not listed.
      const reg = await this.gql<{ findApplicationRegistrationByUniversalIdentifier: { id: string; latestAvailableVersion: string | null } | null }>(ctx, `query($u: String!) { findApplicationRegistrationByUniversalIdentifier(universalIdentifier: $u) { id latestAvailableVersion } }`, { u: app.universalIdentifier });
      const latest = reg.findApplicationRegistrationByUniversalIdentifier?.latestAvailableVersion;
      if (!latest) return { upgraded: false, reason: 'No published version found' };
      if (latest === app.version) return { upgraded: false, from: app.version, to: latest, reason: 'Already up to date' };
      await this.gql(ctx, `mutation($r: String!, $v: String!) { upgradeApplication(appRegistrationId: $r, targetVersion: $v) }`, { r: app.applicationRegistrationId, v: latest });
      return { upgraded: true, from: app.version ?? undefined, to: latest };
    } catch (e) {
      return { upgraded: false, reason: (e as Error).message };
    }
  }
}
