import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { intakeSources, teams, tenants, users, type PipelineConfig } from '../database/schema';
import { TwentyAccessService, type AccessSyncReport } from '../crm/twenty/twenty-access.service';
import { tenantAppSecret } from '../access/app-secret';
import { TenantManifestSchema, type TenantManifest } from './manifest';
import { CRM_ADAPTER, type CrmAdapter } from '../crm/crm-adapter.interface';
import { toTenantContext } from '../tenant/tenant.service';
import { TenantService } from '../tenant/tenant.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { UserFacingError } from '../common/errors';
import { stableStringify } from '../conversation/draft.service';

// jsonb does not preserve key order, so configuration is compared canonically.
const same = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);

export interface ProvisionReport {
  tenantId: string;
  created: boolean;
  configVersion: number;
  crmSchema: { created: string[]; existing: string[]; warnings: string[] } | null;
  users: { created: number; updated: number };
  intakeSources: { created: number; updated: number };
  stageMigrations: Array<{ from: string; to: string; affected: number }>;
  /** Twenty members linked to users by the (operator-attested) manifest e-mail at provisioning time */
  membersLinked: number;
  /** Native Twenty roles/settings brought in line with Bee (null on dry runs) */
  access: AccessSyncReport | null;
  app: { configured: boolean; reason?: string } | null;
  dryRun: boolean;
}

/**
 * Controlled, idempotent tenant provisioning from a versioned manifest (CFG-02, TEN-05).
 * Re-running the same manifest changes nothing; there is no public self-service signup.
 */
@Injectable()
export class TenantProvisioningService {
  constructor(
    private readonly db: DbService,
    private readonly tenantSvc: TenantService,
    private readonly audit: AuditService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly access: TwentyAccessService,
  ) {}

  private pipelineOf(m: TenantManifest, version: number): PipelineConfig {
    return { version, defaultInitialStage: m.pipeline.defaultInitialStage, stages: m.pipeline.stages.map((s, i) => ({ id: s.id, label: s.label, order: i + 1, isTerminal: !!s.terminal, terminalType: s.terminal, requiredFields: s.requiredFields })) };
  }

  async provision(input: unknown, opts: { dryRun?: boolean; actor?: string } = {}): Promise<ProvisionReport> {
    const parsed = TenantManifestSchema.safeParse(input);
    if (!parsed.success) throw new UserFacingError(`Invalid manifest: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'BAD_MANIFEST');
    const m = parsed.data;
    const dryRun = !!opts.dryRun;
    const [existing] = await this.db.db.select().from(tenants).where(eq(tenants.slug, m.slug));
    if (existing && existing.twentyWorkspaceId !== m.twenty.workspaceId) throw new UserFacingError('This slug is already bound to a different Twenty workspace.', 'WORKSPACE_MISMATCH');

    const nextPipelineSame = existing?.pipelineConfig && same(existing.pipelineConfig.stages, this.pipelineOf(m, existing.pipelineConfig.version).stages) && existing.pipelineConfig.defaultInitialStage === m.pipeline.defaultInitialStage;
    const pipeline = this.pipelineOf(m, nextPipelineSame ? existing!.pipelineConfig!.version : (existing?.pipelineConfig?.version ?? 0) + 1);

    // CFG-04: a stage with active records cannot be removed without a previewed migration.
    const report: ProvisionReport = { tenantId: existing?.id ?? '', created: !existing, configVersion: existing?.configVersion ?? 1, crmSchema: null, users: { created: 0, updated: 0 }, intakeSources: { created: 0, updated: 0 }, stageMigrations: [], membersLinked: 0, access: null, app: null, dryRun };
    if (existing?.pipelineConfig) {
      const removed = existing.pipelineConfig.stages.filter((s) => !pipeline.stages.some((n) => n.id === s.id));
      if (removed.length) {
        const ctx = toTenantContext({ ...existing, pipelineConfig: existing.pipelineConfig }, this.config.twenty.apiUrl);
        for (const s of removed) {
          const opps = await this.crm.listOpportunities(ctx, { scope: { kind: 'all' }, stageIds: [s.id], maxRecords: 10_000 });
          const to = m.stageMigrations?.[s.id];
          if (opps.items.length && (!to || !pipeline.stages.some((n) => n.id === to))) throw new UserFacingError(`Stage "${s.id}" has ${opps.items.length} active record(s). Provide stageMigrations.${s.id} → an existing stage (preview with dryRun first).`, 'STAGE_IN_USE');
          report.stageMigrations.push({ from: s.id, to: to ?? '', affected: opps.items.length });
          if (!dryRun && to) for (const o of opps.items) await this.crm.updateOpportunity(ctx, o.id, { stageId: to });
        }
      }
    }
    if (dryRun) return report;

    const values = {
      slug: m.slug, name: m.name, deploymentId: m.deploymentId, twentyWorkspaceId: m.twenty.workspaceId, twentyBaseUrl: m.twenty.baseUrl ?? null, twentyApiTokenRef: m.twenty.apiTokenRef,
      timezone: m.timezone, workingDays: m.workingDays, morningReminderTime: m.morningReminderTime, defaultCurrency: m.defaultCurrency, pipelineConfig: pipeline,
      settings: { ...(existing?.settings ?? {}), ...(m.defaultCountry ? { defaultCountry: m.defaultCountry } : {}), ...(m.twenty.webhookSecretRef ? { twentyWebhookSecretRef: m.twenty.webhookSecretRef } : {}), ...(m.twenty.serviceUser ? { twentyServiceUser: m.twenty.serviceUser } : {}), ...(m.channels?.whatsapp?.accessTokenRef ? { whatsappAccessTokenRef: m.channels.whatsapp.accessTokenRef } : {}) }, quotaLimits: m.quotas ?? null, retentionPolicy: m.retention ?? null, updatedAt: new Date(),
    };
    const changed = !existing || !same(
      [existing.name, existing.timezone, existing.workingDays, existing.morningReminderTime, existing.defaultCurrency, existing.pipelineConfig, existing.twentyBaseUrl, existing.twentyApiTokenRef, existing.quotaLimits, existing.retentionPolicy, existing.settings],
      [values.name, values.timezone, values.workingDays, values.morningReminderTime, values.defaultCurrency, values.pipelineConfig, values.twentyBaseUrl, values.twentyApiTokenRef, values.quotaLimits, values.retentionPolicy, values.settings],
    );
    let tenantId = existing?.id;
    if (!existing) {
      const [row] = await this.db.db.insert(tenants).values({ ...values, configVersion: 1 }).returning();
      tenantId = row.id;
    } else if (changed) {
      await this.db.db.update(tenants).set({ ...values, configVersion: existing.configVersion + 1 }).where(eq(tenants.id, existing.id));
    }
    this.tenantSvc.invalidate(tenantId);
    const [row] = await this.db.db.select().from(tenants).where(eq(tenants.id, tenantId!));
    report.tenantId = row.id; report.configVersion = row.configVersion;

    // Idempotent CRM schema/pipeline provisioning via the metadata API (CFG-02).
    report.crmSchema = await this.crm.ensureSchema(toTenantContext(row, this.config.twenty.apiUrl), pipeline);

    await this.db.tenantTx(row.id, async (tx) => {
      const teamKeys = new Map<string, string>(m.teams.map((t) => [t.key, t.name]));
      for (const u of m.users) for (const k of [u.teamId, ...(u.managedTeamIds ?? [])]) if (k && !teamKeys.has(k)) teamKeys.set(k, k);
      for (const [key, name] of teamKeys) {
        await tx.insert(teams).values({ tenantId: row.id, key, name }).onConflictDoUpdate({ target: [teams.tenantId, teams.key], set: m.teams.some((t) => t.key === key) ? { name, status: 'active', updatedAt: new Date() } : { status: 'active' } });
      }
      for (const u of m.users) {
        const conds = u.email ? sql`lower(${users.email}) = ${u.email.toLowerCase()}` : eq(users.twentyMemberId, u.twentyMemberId!);
        const [cur] = await tx.select().from(users).where(and(eq(users.tenantId, row.id), conds));
        const vals = { displayName: u.displayName, email: u.email?.toLowerCase(), role: u.role, twentyMemberId: u.twentyMemberId, teamId: u.teamId, managedTeamIds: u.managedTeamIds ?? [], timezone: u.timezone, morningReminderTime: u.morningReminderTime, preferredReminderChannel: u.preferredReminderChannel, dualDelivery: u.dualDelivery ?? false };
        if (cur) { await tx.update(users).set({ ...vals, updatedAt: new Date() }).where(eq(users.id, cur.id)); report.users.updated++; }
        else { await tx.insert(users).values({ tenantId: row.id, ...vals }); report.users.created++; }
      }
      const byEmail = async (e?: string) => (e ? (await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, row.id), sql`lower(${users.email}) = ${e.toLowerCase()}`, isNull(users.revokedAt))))[0]?.id : undefined);
      for (const s of m.intakeSources) {
        const routing = { initialStage: s.crmRouting.initialStage, sourceTag: s.crmRouting.sourceTag, ownerUserId: await byEmail(s.crmRouting.ownerEmail), teamId: s.crmRouting.teamId, roundRobinUserIds: (await Promise.all((s.crmRouting.roundRobinEmails ?? []).map(byEmail))).filter(Boolean) as string[], mode: s.crmRouting.mode, repeatPolicy: s.crmRouting.repeatPolicy };
        const [cur] = await tx.select().from(intakeSources).where(eq(intakeSources.sourceId, s.sourceId));
        if (cur && cur.tenantId !== row.id) throw new UserFacingError(`Intake source ${s.sourceId} belongs to another tenant.`, 'SOURCE_CONFLICT');
        const vals = { type: s.type, formLabel: s.formLabel, intakeAlias: s.intakeAlias?.toLowerCase(), parsingRules: s.parsingRules, crmRouting: { ...routing, roundRobinCursor: (cur?.crmRouting as any)?.roundRobinCursor }, followUpConfig: s.followUp, webhookSecretRef: s.webhookSecretRef, mailbox: s.mailbox, updatedAt: new Date() };
        if (cur) { await tx.update(intakeSources).set({ ...vals, configVersion: cur.configVersion + 1 }).where(eq(intakeSources.id, cur.id)); report.intakeSources.updated++; }
        else { await tx.insert(intakeSources).values({ tenantId: row.id, sourceId: s.sourceId, ...vals }); report.intakeSources.created++; }
      }
      if (m.notificationUserEmail) {
        const uid = await byEmail(m.notificationUserEmail);
        if (uid) {
          const dest = { channel: ((await tx.select().from(users).where(eq(users.id, uid)))[0].preferredReminderChannel ?? 'whatsapp') as 'whatsapp' | 'teams', userId: uid };
          await tx.update(tenants).set({ settings: { ...(row.settings ?? {}), ...values.settings, notificationDestination: dest } }).where(eq(tenants.id, row.id));
        }
      }
    });
    this.tenantSvc.invalidate(row.id);
    const ctx = toTenantContext(row, this.config.twenty.apiUrl);

    // IAM-01: the operator-attested manifest binds each listed employee to their Twenty membership. After provisioning,
    // linking happens only explicitly by a client admin; an e-mail match alone never grants access at runtime.
    try {
      const unlinked = await this.db.tenantTx(row.id, (tx) => tx.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.tenantId, row.id), isNull(users.twentyMemberId))));
      const listed = new Set(m.users.map((u) => u.email?.toLowerCase()).filter(Boolean));
      if (unlinked.some((u) => u.email && listed.has(u.email))) {
        const members = await this.crm.listWorkspaceMembers(ctx);
        await this.db.tenantTx(row.id, async (tx) => {
          for (const u of unlinked) {
            const mem = u.email && listed.has(u.email) ? members.find((x) => x.email?.toLowerCase() === u.email) : undefined;
            const taken = mem && (await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, row.id), eq(users.twentyMemberId, mem.id))))[0];
            if (mem && !taken) { await tx.update(users).set({ twentyMemberId: mem.id, updatedAt: new Date() }).where(eq(users.id, u.id)); report.membersLinked++; }
          }
        });
      }
    } catch { /* Twenty unreachable: members can be linked later by a client admin */ }

    report.access = await this.access.sync(ctx);
    if (this.config.web.token) {
      report.app = await this.access.configureApp(ctx, { BEE_CHAT_TOKEN: tenantAppSecret(this.config.web.token, row.id), ...(this.config.web.appBeeUrl ? { BEE_API_URL: this.config.web.appBeeUrl } : {}) });
    }
    await this.audit.write({ tenantId: row.id, action: 'tenant.provisioned', resourceType: 'tenant', resourceId: row.id, metadata: { actor: opts.actor, created: report.created, configVersion: report.configVersion } });
    return report;
  }
}
