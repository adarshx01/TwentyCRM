import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RequirePermission, TwentyApp } from '../common/decorators';
import { AllowUnlinkedMember } from './decorators';
import type { Actor, TwentyCaller } from '../common/guards/auth.guard';
import { ROLE_MATRIX, TENANT_ROLES, permissionsOf, recordScopeOf } from './permissions';
import { UserDirectoryService } from './user-directory.service';
import { OperatorService } from './operator.service';
import { ArchiveRequestService } from '../approvals/archive-request.service';
import { IntakeService } from '../intake/intake.service';
import { TenantConfigService, ConfigPatchSchema } from '../admin/tenant-config.service';
import { TwentyAccessService } from '../crm/twenty/twenty-access.service';
import { CRM_ADAPTER, type CrmAdapter } from '../crm/crm-adapter.interface';
import { DbService } from '../database/db.service';
import { auditLog, users } from '../database/schema';
import { UserFacingError } from '../common/errors';
import { getLogger } from '../observability/logger';

type Req = { actor?: Actor; twenty?: TwentyCaller };
const actorOf = (req: Req): Actor => { if (!req.actor) throw new UserFacingError('Sign in first.', 'AUTH_FORBIDDEN'); return req.actor; };
const tag = (a: Actor) => `user:${a.user.userId}`;
const log = getLogger('access');

const Role = z.enum(TENANT_ROLES);
const Channel = z.enum(['whatsapp', 'teams', 'web']).nullable();
const TeamKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const UserCreate = z.object({ displayName: z.string().min(1).max(255), email: z.string().email().max(255), role: Role, teamId: TeamKey.nullable().optional(), managedTeamIds: z.array(TeamKey).max(50).optional(), timezone: z.string().max(63).nullable().optional(), morningReminderTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(), preferredReminderChannel: Channel.optional() }).strict();
const UserPatch = UserCreate.partial().strict();
const Note = z.object({ note: z.string().max(1000).optional() }).strict();

// ──────────────────────────────────────────────────────────────
// Every employee: who am I, what may I do (and what did I request)
// ──────────────────────────────────────────────────────────────
@Controller('v1/me')
@TwentyApp()
export class MeController {
  constructor(private readonly directory: UserDirectoryService, private readonly archive: ArchiveRequestService) {}

  @Get() @AllowUnlinkedMember()
  async me(@Req() req: Req) {
    if (!req.actor) {
      return { linked: false, workspace: req.twenty ? { name: (req.twenty.tenant as any).tenantSlug } : null, memberId: req.twenty?.memberId ?? null, message: 'Your Twenty account is not linked to a Bee user yet. Ask a client admin to link you in Bee › Administration.' };
    }
    const a = req.actor;
    const u = await this.directory.get(a.tenant.tenantId, a.user.userId);
    return {
      linked: true,
      tenant: { id: a.tenant.tenantId, slug: a.tenant.tenantSlug, timezone: a.tenant.timezone },
      user: { id: u.id, displayName: u.displayName, email: u.email, role: u.role, roleLabel: ROLE_MATRIX[u.role].label, teamId: u.teamId, managedTeamIds: u.managedTeamIds, timezone: u.timezone ?? a.tenant.timezone, morningReminderTime: u.morningReminderTime ?? a.tenant.morningReminderTime, preferredReminderChannel: u.preferredReminderChannel, channels: u.channels },
      scope: recordScopeOf(u.role),
      permissions: permissionsOf(u.role),
    };
  }

  @Get('archive-requests')
  mine(@Req() req: Req) {
    const a = actorOf(req);
    return this.archive.listMine(a.tenant, a.user);
  }

  @Post('archive-requests/:id/cancel') @HttpCode(200)
  cancel(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string) {
    const a = actorOf(req);
    return this.archive.cancel(a.tenant, a.user, id);
  }
}

// ──────────────────────────────────────────────────────────────
// Approvers: archive requests and intake review, each within the approver's own scope
// ──────────────────────────────────────────────────────────────
@Controller('v1/approvals')
@TwentyApp()
export class ApprovalsController {
  constructor(private readonly archive: ArchiveRequestService, private readonly intake: IntakeService) {}

  @Get('archive') @RequirePermission('approvals.decide')
  listArchive(@Req() req: Req, @Query('state') state?: string) {
    const a = actorOf(req);
    return this.archive.listForApprover(a.tenant, a.user, state === 'all' ? 'all' : 'pending');
  }

  @Post('archive/:id/:decision') @HttpCode(200) @RequirePermission('approvals.decide')
  decideArchive(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Param('decision') decision: string, @Body() body: unknown) {
    const a = actorOf(req);
    if (decision !== 'approve' && decision !== 'reject') throw new UserFacingError('Unknown decision.', 'NOT_FOUND');
    return this.archive.decide(a.tenant, a.user, id, decision, Note.parse(body ?? {}).note, req.twenty ? 'web' : 'api');
  }

  @Get('intake') @RequirePermission('intake.review')
  async listIntake(@Req() req: Req) {
    const a = actorOf(req);
    const rows = await this.intake.listReview(a.tenant.tenantId, 'review', { id: a.user.userId, role: a.user.role, managedTeamIds: a.user.managedTeamIds });
    return rows.map((r) => { const { _meta, _fingerprint, ...fields } = (r.parsedFields ?? {}) as Record<string, unknown>; return { id: r.id, reason: r.reviewReason, fields, receivedAt: r.createdAt }; });
  }

  @Post('intake/:id/:decision') @HttpCode(200) @RequirePermission('intake.review')
  async decideIntake(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Param('decision') decision: string) {
    const a = actorOf(req);
    const who = { id: a.user.userId, role: a.user.role, managedTeamIds: a.user.managedTeamIds };
    if (decision === 'approve') { const r = await this.intake.approve(a.tenant.tenantId, id, who); return { id: r.id, state: r.state }; }
    if (decision === 'reject') { const r = await this.intake.reject(a.tenant.tenantId, id, who); return { id: r.id, state: r.state }; }
    throw new UserFacingError('Unknown decision.', 'NOT_FOUND');
  }
}

// ──────────────────────────────────────────────────────────────
// Client admin: users, teams, configuration, audit, support access — own tenant only
// ──────────────────────────────────────────────────────────────
@Controller('v1/tenant-admin')
@TwentyApp()
export class TenantAdminController {
  constructor(
    private readonly directory: UserDirectoryService,
    private readonly operators: OperatorService,
    private readonly config: TenantConfigService,
    private readonly access: TwentyAccessService,
    private readonly db: DbService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
  ) {}

  /** Twenty roles follow Bee after every access change; failures are retried by reconciliation (IAM-05). */
  private resync(a: Actor): void {
    void this.access.sync(a.tenant).catch((e) => log.warn({ tenantId: a.tenant.tenantId, err: (e as Error).message }, 'access resync failed'));
  }

  @Get('roles') @RequirePermission('tenant.users.manage')
  roles() {
    return TENANT_ROLES.map((r) => ({ role: r, label: ROLE_MATRIX[r].label, scope: ROLE_MATRIX[r].scope, permissions: ROLE_MATRIX[r].permissions }));
  }

  @Get('users') @RequirePermission('tenant.users.manage')
  listUsers(@Req() req: Req) { return this.directory.list(actorOf(req).tenant.tenantId); }

  @Post('users') @HttpCode(201) @RequirePermission('tenant.users.manage')
  async createUser(@Req() req: Req, @Body() body: unknown) {
    const a = actorOf(req);
    const u = await this.directory.create(a.tenant.tenantId, UserCreate.parse(body) as any, tag(a));
    this.resync(a);
    return u;
  }

  @Patch('users/:id') @RequirePermission('tenant.users.manage')
  async updateUser(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const a = actorOf(req);
    const u = await this.directory.update(a.tenant.tenantId, id, UserPatch.parse(body) as any, tag(a));
    this.resync(a);
    return u;
  }

  @Post('users/:id/:action') @HttpCode(200) @RequirePermission('tenant.users.manage')
  async userAction(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Param('action') action: string, @Body() body: unknown) {
    const a = actorOf(req);
    const t = a.tenant.tenantId;
    let out: unknown;
    switch (action) {
      case 'revoke': out = await this.directory.revoke(t, id, tag(a)); break;
      case 'reinstate': out = await this.directory.reinstate(t, id, tag(a)); break;
      case 'unlink': out = await this.directory.unlinkMember(t, id, tag(a)); break;
      case 'link': {
        const { memberId } = z.object({ memberId: z.string().min(8).max(64) }).strict().parse(body);
        if (!(await this.crm.listWorkspaceMembers(a.tenant)).some((m) => m.id === memberId)) throw new UserFacingError('That member is not in this Twenty workspace.', 'NOT_FOUND');
        out = await this.directory.linkMember(t, id, memberId, tag(a));
        break;
      }
      case 'enrollment': {
        const b = z.object({ channel: z.enum(['whatsapp', 'teams']), expectedExternalId: z.string().max(512).optional(), ttlMinutes: z.number().int().min(5).max(1440).optional() }).strict().parse(body);
        return this.directory.issueEnrollment(t, id, b.channel, tag(a), { expectedExternalId: b.expectedExternalId, ttlMinutes: b.ttlMinutes });
      }
      default: throw new UserFacingError('Unknown action.', 'NOT_FOUND');
    }
    this.resync(a);
    return out;
  }

  /** Twenty members with their link status. An e-mail match is shown only as a SUGGESTION; linking is explicit. */
  @Get('members') @RequirePermission('tenant.users.manage')
  async members(@Req() req: Req) {
    const a = actorOf(req);
    const [members, list] = await Promise.all([this.crm.listWorkspaceMembers(a.tenant), this.directory.list(a.tenant.tenantId)]);
    return members.map((m) => {
      const linked = list.find((u) => u.twentyMemberId === m.id);
      const email = m.email?.toLowerCase();
      const suggested = !linked && email ? list.find((u) => !u.twentyMemberId && u.email === email) : undefined;
      return { id: m.id, name: m.name, email: m.email, linkedUserId: linked?.id ?? null, suggestedUserId: suggested?.id ?? null };
    });
  }

  @Get('teams') @RequirePermission('tenant.teams.manage')
  teams(@Req() req: Req) { return this.directory.listTeams(actorOf(req).tenant.tenantId); }

  @Post('teams') @HttpCode(200) @RequirePermission('tenant.teams.manage')
  saveTeam(@Req() req: Req, @Body() body: unknown) {
    const a = actorOf(req);
    const b = z.object({ key: TeamKey, name: z.string().min(1).max(255) }).strict().parse(body);
    return this.directory.upsertTeam(a.tenant.tenantId, b.key, b.name, tag(a));
  }

  @Post('teams/:key/deactivate') @HttpCode(200) @RequirePermission('tenant.teams.manage')
  deactivateTeam(@Req() req: Req, @Param('key') key: string) {
    const a = actorOf(req);
    return this.directory.deactivateTeam(a.tenant.tenantId, TeamKey.parse(key), tag(a));
  }

  @Get('config') @RequirePermission('tenant.config.manage')
  getConfig(@Req() req: Req) { return this.config.get(actorOf(req).tenant.tenantId); }

  /** `?dryRun=true` previews (e.g. stage removal impact, CFG-04) without changing anything. */
  @Patch('config') @RequirePermission('tenant.config.manage')
  async patchConfig(@Req() req: Req, @Body() body: unknown, @Query('dryRun') dryRun?: string) {
    const a = actorOf(req);
    const r = await this.config.update(a.tenant.tenantId, ConfigPatchSchema.parse(body), tag(a), dryRun === 'true');
    return { dryRun: r.dryRun, configVersion: r.configVersion, stageMigrations: r.stageMigrations, crmSchemaWarnings: r.crmSchema?.warnings ?? [] };
  }

  @Get('audit') @RequirePermission('tenant.audit.read')
  async audit(@Req() req: Req, @Query('limit') limit?: string, @Query('before') before?: string) {
    const a = actorOf(req);
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const beforeId = Number(before) || undefined;
    const rows = await this.db.tenantTx(a.tenant.tenantId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.tenantId, a.tenant.tenantId), ...(beforeId ? [lt(auditLog.id, beforeId)] : []))).orderBy(desc(auditLog.id)).limit(n));
    const names = await this.db.tenantTx(a.tenant.tenantId, (tx) => tx.select({ id: users.id, name: users.displayName }).from(users).where(eq(users.tenantId, a.tenant.tenantId)));
    return rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const actor = typeof meta.actor === 'string' ? meta.actor : r.userId ? `user:${r.userId}` : 'system';
      const actorName = actor.startsWith('user:') ? names.find((x) => x.id === actor.slice(5))?.name ?? actor : actor.startsWith('operator:') ? `YlogX operator (${actor.slice(9)})` : actor;
      return { id: r.id, at: r.timestamp, action: r.action, actor: actorName, subject: r.userId ? names.find((x) => x.id === r.userId)?.name ?? null : null, resourceType: r.resourceType, resourceId: r.resourceId, result: r.result, channel: r.channel, changedFields: r.changedFields };
    });
  }

  @Get('support') @RequirePermission('tenant.support.approve')
  support(@Req() req: Req) { return this.operators.listGrants(actorOf(req).tenant.tenantId); }

  @Post('support/:id/:decision') @HttpCode(200) @RequirePermission('tenant.support.approve')
  decideSupport(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Param('decision') decision: string) {
    const a = actorOf(req);
    if (!['approve', 'deny', 'revoke'].includes(decision)) throw new UserFacingError('Unknown decision.', 'NOT_FOUND');
    return this.operators.decide(a.tenant.tenantId, id, decision as 'approve' | 'deny' | 'revoke', a.user.userId);
  }

  /** Native Twenty access vs Bee: `GET` previews, `POST` applies now (it also runs automatically). */
  @Get('access') @RequirePermission('tenant.users.manage')
  previewAccess(@Req() req: Req) { return this.access.sync(actorOf(req).tenant, { dryRun: true }); }

  @Post('access/sync') @HttpCode(200) @RequirePermission('tenant.users.manage')
  syncAccess(@Req() req: Req) { return this.access.sync(actorOf(req).tenant); }

  @Get('usage') @RequirePermission('tenant.usage.read')
  async usage(@Req() req: Req, @Query('days') days = '30') {
    const a = actorOf(req);
    const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 400) * 86_400_000).toISOString();
    const rows = await this.db.tenantTx(a.tenant.tenantId, (tx) => tx.execute(sql`select kind, sum(quantity)::bigint as total, count(*)::int as events from usage_events where tenant_id = ${a.tenant.tenantId} and occurred_at >= ${since}::timestamptz group by kind order by kind`));
    return { sinceDays: Number(days) || 30, usage: rows };
  }
}
