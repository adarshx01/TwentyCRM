import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DbService } from '../database/db.service';
import { companyProvisioning, deadLetters, reconciliationState, supportGrants, tenants, usageEvents, users } from '../database/schema';
import { AuditService } from '../audit/audit.service';
import { TenantService } from '../tenant/tenant.service';
import { TwentyAccessService } from '../crm/twenty/twenty-access.service';
import { OperatorService, operatorActor, type OperatorPrincipal } from '../access/operator.service';
import { tenantAppSecret } from '../access/app-secret';
import { UserFacingError } from '../common/errors';
import { PlatformAuditService } from './platform-audit.service';
import { WORKSPACE_FACTORY, type WorkspaceFactory } from './workspace-factory';

/**
 * The platform operator's view of the service (§4): companies, their health and their administrators — never their CRM
 * records. Anything beyond metadata needs a support grant the client admin approved.
 */
@Injectable()
export class PlatformService {
  constructor(
    private readonly db: DbService,
    private readonly operators: OperatorService,
    private readonly tenantSvc: TenantService,
    private readonly access: TwentyAccessService,
    private readonly audit: AuditService,
    private readonly platformAudit: PlatformAuditService,
    @Inject(WORKSPACE_FACTORY) private readonly factory: WorkspaceFactory,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Caddy asks before it requests a certificate for a host name (on-demand TLS): only names this deployment really serves
   * may get one, so nobody can make the server issue certificates for arbitrary names pointed at its address.
   */
  async tlsAllowed(domain: string): Promise<boolean> {
    const hostOf = (u?: string | null) => { try { return u ? new URL(u).hostname.toLowerCase() : null; } catch { return null; } };
    const host = domain.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/.test(host)) return false;
    const p = this.config.platform;
    const base = hostOf(p.twentyUrl);
    if (!base) return false;
    // Twenty builds some links (file uploads, e-mailed links) from its bare base domain, i.e. the platform host without "app.".
    const apex = base.split('.').slice(1).join('.');
    if (host === base || host === apex || host === hostOf(p.workspaceUrl)) return true;
    const rows = await this.db.db.select({ u: tenants.twentyBaseUrl }).from(tenants);
    if (rows.some((r) => hostOf(r.u) === host)) return true;
    // Creating a workspace: Twenty first hands out a generated address, which must be reachable over HTTPS to finish the
    // set-up. That is allowed only while the platform plane is being set up, or while a creation is actually running.
    const sameBase = host.split('.').slice(1).join('.') === base.split('.').slice(1).join('.');
    if (sameBase && !p.workspaceId) return true;
    if (sameBase) {
      const recent = new Date(Date.now() - 10 * 60_000);
      const [running] = await this.db.systemTx((tx) => tx.select({ slug: companyProvisioning.slug }).from(companyProvisioning).where(and(eq(companyProvisioning.state, 'running'), sql`${companyProvisioning.updatedAt} > ${recent.toISOString()}::timestamptz`)).limit(1));
      if (running) return true;
    }
    // A company being created: its address is <slug>.<same base as the platform host>.
    const label = host.split('.')[0];
    if (host === `${label}.${base.split('.').slice(1).join('.')}`) {
      const [pending] = await this.db.systemTx((tx) => tx.select({ slug: companyProvisioning.slug }).from(companyProvisioning).where(eq(companyProvisioning.slug, label)));
      if (pending) return true;
    }
    return false;
  }

  /** What this deployment can do (shown at the top of the console). */
  health() {
    const p = this.config.platform;
    return {
      companyCreation: !!(p.twentyUrl && p.adminEmail && p.adminPasswordRef && this.config.security.secretsMasterKey),
      missing: [
        !p.twentyUrl && 'PLATFORM_TWENTY_URL', !p.adminEmail && 'PLATFORM_ADMIN_EMAIL', !p.adminPasswordRef && 'PLATFORM_ADMIN_PASSWORD',
        !this.config.security.secretsMasterKey && 'SECRETS_MASTER_KEY', !p.workspaceUrl && 'PLATFORM_WORKSPACE_URL',
      ].filter(Boolean) as string[],
      workspaceUrl: p.workspaceUrl ?? null,
    };
  }

  async companies() {
    const rows = await this.db.db.select().from(tenants);
    const ids = rows.map((r) => r.id);
    if (!ids.length) return [];
    const userCounts = await this.db.systemTx((tx) => tx.select({ tenantId: users.tenantId, status: users.status, n: count() }).from(users).where(inArray(users.tenantId, ids)).groupBy(users.tenantId, users.status));
    const dead = await this.db.systemTx((tx) => tx.select({ tenantId: deadLetters.tenantId, n: count() }).from(deadLetters).where(and(isNull(deadLetters.resolvedAt), inArray(deadLetters.tenantId, ids))).groupBy(deadLetters.tenantId));
    const pendingSupport = await this.db.systemTx((tx) => tx.select({ tenantId: supportGrants.tenantId, n: count() }).from(supportGrants).where(and(eq(supportGrants.state, 'requested'), inArray(supportGrants.tenantId, ids))).groupBy(supportGrants.tenantId));
    const recon = await this.db.systemTx((tx) => tx.select({ tenantId: reconciliationState.tenantId, last: sql<Date | null>`max(${reconciliationState.lastRunAt})`, err: sql<string | null>`max(${reconciliationState.lastError})` }).from(reconciliationState).where(inArray(reconciliationState.tenantId, ids)).groupBy(reconciliationState.tenantId));
    return rows
      .map((t) => {
        const uc = userCounts.filter((x) => x.tenantId === t.id);
        const r = recon.find((x) => x.tenantId === t.id);
        return {
          id: t.id, slug: t.slug, name: t.name, status: t.status, configVersion: t.configVersion, timezone: t.timezone, currency: t.defaultCurrency,
          workspaceUrl: t.twentyBaseUrl, users: { active: uc.find((x) => x.status === 'active')?.n ?? 0, revoked: uc.find((x) => x.status !== 'active')?.n ?? 0 },
          openDeadLetters: dead.find((x) => x.tenantId === t.id)?.n ?? 0, pendingSupportRequests: pendingSupport.find((x) => x.tenantId === t.id)?.n ?? 0,
          lastReconciledAt: r?.last ?? null, reconciliationError: r?.err ?? null, createdAt: t.createdAt,
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async company(tenantId: string) {
    const [t] = await this.db.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!t) throw new UserFacingError('Company not found.', 'NOT_FOUND');
    const staff = await this.db.tenantTx(tenantId, (tx) => tx.select({ id: users.id, displayName: users.displayName, email: users.email, role: users.role, status: users.status, team: users.teamId, linked: users.twentyMemberId, invitedAt: users.twentyInvitedAt }).from(users).where(eq(users.tenantId, tenantId)));
    const since = new Date(Date.now() - 30 * 86_400_000);
    const usage = await this.db.tenantTx(tenantId, (tx) => tx.select({ kind: usageEvents.kind, total: sql<number>`sum(${usageEvents.quantity})::bigint`, events: count() }).from(usageEvents).where(and(eq(usageEvents.tenantId, tenantId), sql`${usageEvents.occurredAt} >= ${since.toISOString()}::timestamptz`)).groupBy(usageEvents.kind));
    const grants = await this.operators.listGrants(tenantId);
    const [dead] = await this.db.systemTx((tx) => tx.select({ n: count() }).from(deadLetters).where(and(eq(deadLetters.tenantId, tenantId), isNull(deadLetters.resolvedAt))));
    return {
      id: t.id, slug: t.slug, name: t.name, status: t.status, configVersion: t.configVersion, deploymentId: t.deploymentId, workspaceId: t.twentyWorkspaceId, workspaceUrl: t.twentyBaseUrl,
      timezone: t.timezone, currency: t.defaultCurrency, morningReminderTime: t.morningReminderTime, workingDays: t.workingDays,
      pipeline: (t.pipelineConfig?.stages ?? []).map((s) => ({ id: s.id, label: s.label, terminal: s.terminalType })),
      serviceUser: t.settings?.twentyServiceUser?.email ?? null,
      users: staff.map((u) => ({ id: u.id, name: u.displayName, email: u.email, role: u.role, status: u.status, team: u.team, linked: !!u.linked, invited: !!u.invitedAt })),
      usage30d: usage.map((u) => ({ kind: u.kind, total: Number(u.total), events: u.events })),
      openDeadLetters: dead?.n ?? 0,
      supportGrants: grants.map((g) => ({ id: g.id, reason: g.reason, hours: g.hours, state: g.effectiveState, createdAt: g.createdAt, expiresAt: g.expiresAt, operator: g.operator?.name ?? null })),
    };
  }

  async setStatus(tenantId: string, status: 'active' | 'suspended', operator: OperatorPrincipal, reason?: string) {
    const [t] = await this.db.db.select({ id: tenants.id, status: tenants.status, slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId));
    if (!t) throw new UserFacingError('Company not found.', 'NOT_FOUND');
    if (t.status === status) return { status };
    await this.db.db.update(tenants).set({ status, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
    this.tenantSvc.invalidate(tenantId);
    // The company's own admin can see this in their audit trail.
    await this.audit.write({ tenantId, action: status === 'suspended' ? 'tenant.suspended' : 'tenant.reactivated', resourceType: 'tenant', resourceId: tenantId, metadata: { actor: operatorActor(operator), reason: reason ?? null } });
    await this.platformAudit.write(operator, status === 'suspended' ? 'company.suspended' : 'company.reactivated', { tenantId, target: t.slug, metadata: { reason: reason ?? null } });
    return { status };
  }

  async resync(tenantId: string, operator: OperatorPrincipal) {
    const ctx = await this.tenantSvc.getContext(tenantId).catch(() => null);
    if (!ctx) throw new UserFacingError('This company is suspended or unavailable.', 'BAD_STATE');
    const report = await this.access.sync(ctx);
    await this.platformAudit.write(operator, 'company.access_resync', { tenantId, target: ctx.tenantSlug, result: report.ok ? 'success' : 'failure', metadata: { changes: report.memberChanges.length, error: report.error ?? null } });
    return report;
  }

  async configureApp(tenantId: string, operator: OperatorPrincipal) {
    const ctx = await this.tenantSvc.getContext(tenantId);
    const master = this.config.web.token;
    if (!master) throw new UserFacingError('CRM_CHAT_TOKEN is not configured.', 'NOT_CONFIGURED');
    const r = await this.access.configureApp(ctx, { BEE_CHAT_TOKEN: tenantAppSecret(master, tenantId), ...(this.config.web.appBeeUrl ? { BEE_API_URL: this.config.web.appBeeUrl } : {}) });
    await this.platformAudit.write(operator, 'company.app_configured', { tenantId, target: ctx.tenantSlug, metadata: r as Record<string, unknown> });
    return r;
  }

  async upgradeApp(tenantId: string, operator: OperatorPrincipal) {
    const ctx = await this.tenantSvc.getContext(tenantId);
    const r = await this.access.upgradeApp(ctx);
    await this.platformAudit.write(operator, 'company.app_upgraded', { tenantId, target: ctx.tenantSlug, result: r.upgraded || r.reason === 'Already up to date' ? 'success' : 'failure', metadata: r as Record<string, unknown> });
    return r;
  }

  async requestSupport(tenantId: string, operator: OperatorPrincipal, reason: string, hours: number) {
    const g = await this.operators.requestSupport(tenantId, operator, reason, hours);
    await this.platformAudit.write(operator, 'support.requested', { tenantId, target: g.id, metadata: { hours: g.hours } });
    return g;
  }

  // ── operators ──────────────────────────────────────────────
  /** Link operators to the platform-workspace member that accepted their invitation (same mailbox they were invited on). */
  async syncOperators(): Promise<number> {
    const [list, members] = await Promise.all([this.operators.listDetailed(), this.factory.listPlatformMembers().catch(() => [])]);
    let linked = 0;
    const taken = new Set(list.map((o) => o.linked).filter(Boolean));
    for (const o of list) {
      if (o.linked || o.status !== 'active' || !o.invitedAt) continue;
      const m = members.find((x) => x.email?.toLowerCase() === o.email.toLowerCase() && !taken.has(x.id));
      if (m) { await this.operators.linkMember(o.id, m.id); taken.add(m.id); linked++; }
    }
    return linked;
  }

  private readonly adoptionChecked = new Map<string, number>();

  /** An invited operator signs in for the first time: link their member right away (same mailbox the invitation went to). */
  async adoptOperator(memberId: string): Promise<boolean> {
    const now = Date.now();
    if ((this.adoptionChecked.get(memberId) ?? 0) > now - 5_000) return false;
    this.adoptionChecked.set(memberId, now);
    if (this.adoptionChecked.size > 1000) this.adoptionChecked.clear();
    const [list, members] = await Promise.all([this.operators.listDetailed(), this.factory.listPlatformMembers().catch(() => [])]);
    const m = members.find((x) => x.id === memberId);
    if (!m?.email) return false;
    const o = list.find((x) => !x.linked && x.status === 'active' && !!x.invitedAt && x.email.toLowerCase() === m.email!.toLowerCase());
    if (!o) return false;
    await this.operators.linkMember(o.id, memberId);
    return true;
  }

  async listOperators() {
    await this.syncOperators();
    return (await this.operators.listDetailed()).map((o) => ({ id: o.id, name: o.name, email: o.email, status: o.status, signedIn: !!o.linked, invited: !!o.invitedAt, lastUsedAt: o.lastUsedAt, createdAt: o.createdAt }));
  }

  async addOperator(input: { name: string; email: string }, by: OperatorPrincipal) {
    const created = await this.operators.create(input, by);
    const invite = await this.factory.invitePlatformMember(input.email.toLowerCase());
    if (invite.sent) await this.operators.markInvited(created.id);
    await this.platformAudit.write(by, 'operator.created', { target: input.email, metadata: { invitationSent: invite.sent } });
    // The API key is shown once, for CLI/automation use; console sign-in is the Twenty invitation.
    return { id: created.id, apiKey: created.key, invitation: invite };
  }

  async revokeOperator(id: string, by: OperatorPrincipal) {
    await this.operators.revoke(id, by);
    await this.platformAudit.write(by, 'operator.revoked', { target: id });
    return { status: 'revoked' };
  }

  recentAudit(limit?: number) {
    return this.platformAudit.recent(limit);
  }

  /** Newest tenant-side audit entries for one company; allowed only under an active support grant. */
  async companyAudit(tenantId: string, operator: OperatorPrincipal, limit = 50) {
    await this.operators.requireGrant(tenantId, operator, 'read audit trail');
    const { auditLog } = await import('../database/schema');
    const rows = await this.db.tenantTx(tenantId, (tx) => tx.select().from(auditLog).where(eq(auditLog.tenantId, tenantId)).orderBy(desc(auditLog.id)).limit(Math.min(limit, 200)));
    return rows.map((r) => ({ id: r.id, at: r.timestamp, action: r.action, resourceType: r.resourceType, result: r.result }));
  }
}
