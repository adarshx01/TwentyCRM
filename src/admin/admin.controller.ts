import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Patch, Req } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AdminOnly } from '../common/decorators';
import { DbService } from '../database/db.service';
import { channelBindings, deadLetters, tenants, users } from '../database/schema';
import { IdentityService } from '../identity/identity.service';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { generateToken } from '../common/guards/auth.guard';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { QueueService } from '../queue/queue.service';
import { QueueName, QUEUES } from '../queue/queues';
import { AuditService } from '../audit/audit.service';
import { ReconciliationService } from '../crm/reconciliation.service';
import { OperationJournal } from '../crm/operations/operation-journal.service';
import { UserFacingError } from '../common/errors';
import { OperatorService, operatorActor, type OperatorPrincipal } from '../access/operator.service';
import { TwentyAccessService } from '../crm/twenty/twenty-access.service';
import { TenantService } from '../tenant/tenant.service';
import { tenantAppSecret } from '../access/app-secret';
import { UserDirectoryService } from '../access/user-directory.service';

type OpReq = { operator: OperatorPrincipal };
const OperatorCreate = z.object({ name: z.string().min(1).max(255), email: z.string().email() }).strict();
const SupportRequest = z.object({ reason: z.string().min(10).max(2000), hours: z.number().int().min(1).max(72).default(4) }).strict();

const Enroll = z.object({ channel: z.enum(['whatsapp', 'teams', 'dev', 'web']), expectedExternalId: z.string().max(512).optional(), ttlMinutes: z.number().int().min(5).max(1440).optional() }).strict();
const RolePatch = z.object({ role: z.enum(['salesperson', 'manager', 'cxo', 'client_admin']).optional(), teamId: z.string().nullable().optional(), managedTeamIds: z.array(z.string()).optional() }).strict();

/**
 * Platform-operator API (service administration, §4). Every call is made by a NAMED operator (or the bootstrap key,
 * used to create operators) and audited under that identity. Operators provision and operate tenants; anything that
 * exposes a tenant's customer data (user tokens, job payloads) needs a support grant approved by a client admin of
 * that tenant. There is no public signup.
 */
@Controller('admin')
@AdminOnly()
export class AdminController {
  constructor(
    private readonly db: DbService,
    private readonly provisioning: TenantProvisioningService,
    private readonly identity: IdentityService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly reconcile: ReconciliationService,
    private readonly journal: OperationJournal,
    private readonly operators: OperatorService,
    private readonly directory: UserDirectoryService,
    private readonly access: TwentyAccessService,
    private readonly tenantSvc: TenantService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── operators (bootstrap key only) ─────────────────────────
  @Post('operators') @HttpCode(201)
  async createOperator(@Req() req: OpReq, @Body() body: unknown) {
    const r = await this.operators.create(OperatorCreate.parse(body), req.operator);
    return { id: r.id, key: r.key, note: 'Shown once. Store it in your password manager.' };
  }

  @Get('operators')
  listOperators() { return this.operators.list(); }

  @Post('operators/:id/revoke') @HttpCode(200)
  async revokeOperator(@Req() req: OpReq, @Param('id', ParseUUIDPipe) id: string) {
    await this.operators.revoke(id, req.operator);
    return { status: 'revoked' };
  }

  // ── support access (client-approved) ───────────────────────
  @Post('tenants/:id/support-requests') @HttpCode(201)
  requestSupport(@Req() req: OpReq, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = SupportRequest.parse(body);
    return this.operators.requestSupport(id, req.operator, b.reason, b.hours);
  }

  @Get('tenants/:id/support-grants')
  supportGrants(@Param('id', ParseUUIDPipe) id: string) { return this.operators.listGrants(id); }

  // ── Twenty access / app wiring ─────────────────────────────
  @Post('tenants/:id/access-sync') @HttpCode(200)
  async accessSync(@Param('id', ParseUUIDPipe) id: string) {
    return this.access.sync(await this.tenantSvc.getContext(id));
  }

  /** Configure the CRM Bee app in the tenant's workspace (its own secret, never another tenant's). */
  @Post('tenants/:id/app-config') @HttpCode(200)
  async appConfig(@Req() req: OpReq, @Param('id', ParseUUIDPipe) id: string) {
    if (!this.config.web.token) throw new UserFacingError('CRM_CHAT_TOKEN is not configured.', 'NOT_CONFIGURED');
    const ctx = await this.tenantSvc.getContext(id);
    const r = await this.access.configureApp(ctx, { BEE_CHAT_TOKEN: tenantAppSecret(this.config.web.token, id), ...(this.config.web.appBeeUrl ? { BEE_API_URL: this.config.web.appBeeUrl } : {}) });
    await this.audit.write({ tenantId: id, action: 'tenant.app_configured', resourceType: 'tenant', resourceId: id, metadata: { actor: operatorActor(req.operator), ...r } });
    return r;
  }

  @Post('tenants') @HttpCode(200)
  provision(@Req() req: OpReq, @Body() body: unknown, @Query('dryRun') dryRun?: string) {
    return this.provisioning.provision(body, { dryRun: dryRun === 'true', actor: operatorActor(req.operator) });
  }

  @Get('tenants')
  async list() {
    return (await this.db.db.select({ id: tenants.id, slug: tenants.slug, name: tenants.name, status: tenants.status, configVersion: tenants.configVersion, deploymentId: tenants.deploymentId }).from(tenants));
  }

  @Get('tenants/:id/users')
  async tenantUsers(@Param('id', ParseUUIDPipe) id: string) {
    const rows = await this.db.tenantTx(id, (tx) => tx.select({ id: users.id, displayName: users.displayName, email: users.email, role: users.role, status: users.status, teamId: users.teamId }).from(users).where(eq(users.tenantId, id)));
    const bindings = await this.db.tenantTx(id, (tx) => tx.select({ userId: channelBindings.userId, channel: channelBindings.channel, status: channelBindings.status }).from(channelBindings).where(eq(channelBindings.tenantId, id)));
    return rows.map((u) => ({ ...u, channels: bindings.filter((b) => b.userId === u.id).map((b) => `${b.channel}:${b.status}`) }));
  }

  @Post('tenants/:id/users/:userId/enrollment') @HttpCode(200)
  async enroll(@Req() req: OpReq, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    const b = Enroll.parse(body);
    const r = await this.identity.createEnrollment({ tenantId: id, userId, channel: b.channel, expectedExternalId: b.expectedExternalId, ttlMinutes: b.ttlMinutes, createdBy: operatorActor(req.operator) });
    // The code is shown once and must be delivered through an authenticated company process (IAM-02).
    return { code: r.code, expiresAt: r.expiresAt, instructions: `Employee sends "${r.code}" to the ${b.channel} bot from their own account.` };
  }

  @Post('tenants/:id/users/:userId/revoke') @HttpCode(200)
  async revoke(@Req() req: OpReq, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string) {
    await this.identity.revokeUser(id, userId, operatorActor(req.operator));
    return { status: 'revoked' };
  }

  @Patch('tenants/:id/users/:userId')
  async patchUser(@Req() req: OpReq, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    // Same rules as a client admin's change (validated teams, last-admin protection, drafts re-previewed).
    const b = RolePatch.parse(body);
    await this.directory.update(id, userId, b, operatorActor(req.operator));
    return { status: 'updated' };
  }

  /** Short-lived token to act as an employee: support access only, under an approved grant (§4). */
  @Post('tenants/:id/users/:userId/token') @HttpCode(200)
  async token(@Req() req: OpReq, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string) {
    await this.operators.requireGrant(id, req.operator, `token for user ${userId}`);
    const live = await this.identity.getActiveUser(id, userId);
    if (!live) throw new NotFoundException('User not found or inactive');
    await this.audit.write({ tenantId: id, userId, action: 'admin.token_issued', resourceType: 'user', resourceId: userId, metadata: { actor: operatorActor(req.operator) } });
    return { token: generateToken({ userId, tenantId: id }, this.config.security.jwtSecret, 3600), expiresInSeconds: 3600 };
  }

  @Post('tenants/:id/reconcile') @HttpCode(200)
  async runReconcile(@Param('id', ParseUUIDPipe) id: string) {
    return this.reconcile.run(id);
  }

  /** Usage and cost telemetry per tenant: model tokens, transcription seconds, vision calls, media bytes (§11). */
  @Get('tenants/:id/usage')
  async usage(@Param('id', ParseUUIDPipe) id: string, @Query('days') days = '30') {
    const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 400) * 86_400_000);
    const rows = await this.db.tenantTx(id, (tx) => tx.execute(sql`select kind, sum(quantity)::bigint as total, count(*)::int as events from usage_events where tenant_id = ${id} and occurred_at >= ${since.toISOString()}::timestamptz group by kind order by kind`));
    const msgs = await this.db.tenantTx(id, (tx) => tx.execute(sql`select channel, count(*)::int as n from delivery_state where tenant_id = ${id} and status in ('sent','delivered','read') and created_at >= ${since.toISOString()}::timestamptz group by channel`));
    return { sinceDays: Number(days) || 30, usage: rows, channelMessages: msgs };
  }

  // ── dead letters ────────────────────────────────────────────
  @Get('dead-letters')
  async deadLetters(@Req() req: OpReq, @Query('open') open = 'true') {
    const rows = await this.db.systemTx((tx) => tx.select().from(deadLetters).where(open === 'true' ? isNull(deadLetters.resolvedAt) : undefined).orderBy(desc(deadLetters.createdAt)).limit(200));
    // Job payloads can hold customer content: shown only for tenants the operator holds an active support grant for.
    const granted = await this.operators.activeTenantGrants(req.operator);
    return rows.map((r) => (r.tenantId && !granted.has(r.tenantId) ? { ...r, payload: { redacted: true, keys: Object.keys((r.payload ?? {}) as object) } } : r));
  }

  @Post('dead-letters/:id/retry') @HttpCode(200)
  async retry(@Req() req: OpReq, @Param('id', ParseUUIDPipe) id: string) {
    const [dl] = await this.db.systemTx((tx) => tx.select().from(deadLetters).where(and(eq(deadLetters.id, id), isNull(deadLetters.resolvedAt))));
    if (!dl) throw new NotFoundException('Dead letter not found');
    if (!(Object.values(QUEUES) as string[]).includes(dl.queue)) throw new UserFacingError('This record cannot be re-queued.', 'NOT_RETRYABLE');
    const { _m, ...data } = (dl.payload ?? {}) as any;
    // A failed CRM operation is reopened first; only its missing steps run again (journal keeps committed steps).
    if (dl.queue === QUEUES.CRM_WRITE && dl.tenantId && data.operationId) await this.journal.reopen(dl.tenantId, data.operationId, operatorActor(req.operator));
    await this.queue.send(dl.queue as QueueName, data, { tenantId: dl.tenantId ?? undefined, correlationId: dl.correlationId ?? undefined, idempotencyKey: `dlq-retry:${dl.id}` });
    await this.db.systemTx((tx) => tx.update(deadLetters).set({ resolvedAt: new Date() }).where(eq(deadLetters.id, id)));
    return { status: 'requeued' };
  }

  @Post('dead-letters/:id/resolve') @HttpCode(200)
  async resolve(@Param('id', ParseUUIDPipe) id: string) {
    await this.db.systemTx((tx) => tx.update(deadLetters).set({ resolvedAt: new Date() }).where(eq(deadLetters.id, id)));
    return { status: 'resolved' };
  }
}
