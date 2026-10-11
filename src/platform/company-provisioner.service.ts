import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DbService } from '../database/db.service';
import { companyProvisioning, tenants } from '../database/schema';
import { TenantProvisioningService, type ProvisionReport } from '../admin/tenant-provisioning.service';
import { TenantService } from '../tenant/tenant.service';
import { TwentyAccessService } from '../crm/twenty/twenty-access.service';
import { UserDirectoryService } from '../access/user-directory.service';
import { SecretVault } from '../secrets/secret-vault';
import { UserFacingError } from '../common/errors';
import { type OperatorPrincipal } from '../access/operator.service';
import { PlatformAuditService } from './platform-audit.service';
import { WORKSPACE_FACTORY, type CreatedWorkspace, type WorkspaceFactory } from './workspace-factory';

export const PIPELINE_PRESETS: Record<string, { defaultInitialStage: string; stages: Array<{ id: string; label: string; terminal?: 'won' | 'lost' }> }> = {
  standard: { defaultInitialStage: 'new', stages: [{ id: 'new', label: 'New' }, { id: 'qualified', label: 'Qualified' }, { id: 'meeting', label: 'Meeting' }, { id: 'proposal', label: 'Proposal' }, { id: 'negotiation', label: 'Negotiation' }, { id: 'won', label: 'Won', terminal: 'won' }, { id: 'lost', label: 'Lost', terminal: 'lost' }] },
  simple: { defaultInitialStage: 'prospect', stages: [{ id: 'prospect', label: 'Prospect' }, { id: 'discovery', label: 'Discovery' }, { id: 'quote', label: 'Quote sent' }, { id: 'won', label: 'Won', terminal: 'won' }, { id: 'lost', label: 'Lost', terminal: 'lost' }] },
};

const RESERVED = new Set(['app', 'www', 'api', 'admin', 'ylogx', 'platform', 'bee', 'mail', 'static', 'cdn', 'status', 'docs']);

export const CreateCompanySchema = z.object({
  name: z.string().min(2).max(120),
  /** Becomes the workspace subdomain: <slug>.<instance domain> */
  slug: z.string().regex(/^[a-z][a-z0-9-]{2,28}[a-z0-9]$/, 'lowercase letters, digits and "-" (4–30 characters, starting with a letter)'),
  adminName: z.string().min(2).max(120),
  adminEmail: z.string().email().max(200),
  timezone: z.string().default('UTC').refine((z0) => { try { new Intl.DateTimeFormat('en', { timeZone: z0 }); return true; } catch { return false; } }, 'unknown IANA time zone'),
  defaultCurrency: z.string().length(3).default('INR'),
  defaultCountry: z.string().length(2).optional(),
  morningReminderTime: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
  pipelinePreset: z.enum(['standard', 'simple']).default('standard'),
  teams: z.array(z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), name: z.string().min(1).max(120) }).strict()).max(20).default([]),
}).strict();
export type CreateCompany = z.infer<typeof CreateCompanySchema>;

type Progress = {
  workspace?: CreatedWorkspace;
  apiKeyRef?: string;
  serviceEmail?: string;
  servicePasswordRef?: string;
  serviceUserCreated?: boolean;
  appInstalled?: boolean;
  tenantId?: string;
  provisioned?: boolean;
  invited?: { sent: boolean; error?: string };
  platformAccountRemoved?: boolean;
  steps: Array<{ step: string; at: string }>;
};

export interface CompanyResult {
  state: 'ready';
  tenantId: string;
  slug: string;
  workspaceUrl: string;
  adminEmail: string;
  invitation: { sent: boolean; error?: string };
  access: ProvisionReport['access'];
  steps: string[];
}

/**
 * Creates a client company end to end (BRD §1 "one isolated Twenty workspace per client", §9 controlled provisioning):
 * workspace → integration key → Bee service user → app install → tenant provisioning (roles, hardening, config) →
 * first client admin invited → provisioning account removed. Every step is recorded, so a failure resumes where it
 * stopped and never creates a second workspace. Credentials land in the encrypted vault, never in a manifest.
 */
@Injectable()
export class CompanyProvisioner {
  constructor(
    private readonly db: DbService,
    private readonly provisioning: TenantProvisioningService,
    private readonly access: TwentyAccessService,
    private readonly directory: UserDirectoryService,
    private readonly tenantSvc: TenantService,
    private readonly vault: SecretVault,
    private readonly audit: PlatformAuditService,
    @Inject(WORKSPACE_FACTORY) private readonly factory: WorkspaceFactory,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async load(slug: string) {
    const [row] = await this.db.systemTx((tx) => tx.select().from(companyProvisioning).where(eq(companyProvisioning.slug, slug)));
    return row;
  }

  private save(slug: string, patch: Partial<typeof companyProvisioning.$inferInsert>) {
    return this.db.systemTx((tx) => tx.update(companyProvisioning).set({ ...patch, updatedAt: new Date() }).where(eq(companyProvisioning.slug, slug)));
  }

  /** Previously started creations, newest first (for the console's "in progress / failed" list). */
  async list() {
    const rows = await this.db.systemTx((tx) => tx.select().from(companyProvisioning));
    return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).map((r) => ({ slug: r.slug, state: r.state, error: r.error, name: (r.request as { name?: string }).name, request: r.request, steps: ((r.progress as Partial<Progress>).steps ?? []).map((x) => x.step), workspaceUrl: (r.progress as Partial<Progress>).workspace?.url ?? null, invitation: (r.progress as Partial<Progress>).invited ?? null, updatedAt: r.updatedAt, tenantId: r.tenantId }));
  }

  private readonly inFlight = new Set<string>();

  /**
   * Accept a creation and run it in the background. Twenty's app routes give a request 20 seconds, a workspace takes
   * longer, so the console starts the run and then watches list() until it is ready or failed.
   */
  async start(raw: unknown, operator: OperatorPrincipal): Promise<{ state: 'running'; slug: string }> {
    const { req, row } = await this.prepare(raw, operator);
    if (!this.inFlight.has(req.slug)) void this.execute(req, operator, row).catch(() => undefined);
    return { state: 'running', slug: req.slug };
  }

  /** Create a company and wait for it (CLI, tests). */
  async create(raw: unknown, operator: OperatorPrincipal): Promise<CompanyResult> {
    const { req, row } = await this.prepare(raw, operator);
    return this.execute(req, operator, row);
  }

  private async prepare(raw: unknown, operator: OperatorPrincipal) {
    if (!this.config.platform.twentyUrl || !this.config.platform.adminEmail) throw new UserFacingError('Company creation is not configured on this deployment (PLATFORM_TWENTY_URL / PLATFORM_ADMIN_EMAIL).', 'NOT_CONFIGURED');
    if (!this.config.security.secretsMasterKey) throw new UserFacingError('SECRETS_MASTER_KEY is not configured: provisioned credentials cannot be stored safely.', 'NOT_CONFIGURED');
    const parsed = CreateCompanySchema.safeParse(raw);
    if (!parsed.success) throw new UserFacingError(`Invalid company: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'BAD_COMPANY');
    const req = parsed.data;
    if (RESERVED.has(req.slug)) throw new UserFacingError(`"${req.slug}" is a reserved name. Choose another.`, 'SLUG_CONFLICT');

    let row = await this.load(req.slug);
    if (row?.state === 'ready') throw new UserFacingError(`The company "${req.slug}" already exists.`, 'SLUG_CONFLICT');
    if (!row) {
      const [exists] = await this.db.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, req.slug));
      if (exists) throw new UserFacingError(`A company with the name "${req.slug}" already exists.`, 'SLUG_CONFLICT');
      if (await this.factory.subdomainTaken(req.slug)) throw new UserFacingError(`The address "${req.slug}" is already in use on the Twenty server. Choose another.`, 'SLUG_CONFLICT');
      await this.db.systemTx((tx) => tx.insert(companyProvisioning).values({ slug: req.slug, request: req as unknown as Record<string, unknown>, createdBy: operator.id }));
      row = (await this.load(req.slug))!;
    } else if (JSON.stringify(row.request) !== JSON.stringify(req)) {
      // A retry may correct the request, but never the address of a workspace that already exists.
      await this.save(req.slug, { request: req as unknown as Record<string, unknown> });
    }
    return { req, row };
  }

  private async execute(req: CreateCompany, operator: OperatorPrincipal, row: NonNullable<Awaited<ReturnType<CompanyProvisioner['load']>>>): Promise<CompanyResult> {
    if (this.inFlight.has(req.slug)) throw new UserFacingError(`"${req.slug}" is already being created.`, 'BAD_STATE');
    this.inFlight.add(req.slug);
    try {
      return await this.run(req, operator, row);
    } finally {
      this.inFlight.delete(req.slug);
    }
  }

  private async run(req: CreateCompany, operator: OperatorPrincipal, row: NonNullable<Awaited<ReturnType<CompanyProvisioner['load']>>>): Promise<CompanyResult> {
    await this.save(req.slug, { state: 'running', error: null });
    const p: Progress = { steps: [], ...((row.progress ?? {}) as Partial<Progress>) };
    const done = async (step: string) => { p.steps.push({ step, at: new Date().toISOString() }); await this.save(req.slug, { progress: p as unknown as Record<string, unknown> }); };
    let current = 'start';
    try {
      // 1. the company's own isolated workspace
      if (!p.workspace) {
        current = 'workspace';
        p.workspace = await this.factory.createWorkspace({ displayName: req.name, subdomain: req.slug });
        await done('workspace created');
      }
      const ws = p.workspace;

      // 2. credentials (vault) for the integration key and the per-workspace Bee service user
      if (!p.apiKeyRef) {
        current = 'integration key';
        p.apiKeyRef = await this.vault.put(`tenant/${req.slug}/twenty_api_key`, await this.factory.createApiKey(ws));
        await done('integration key created');
      }
      if (!p.serviceUserCreated) {
        current = 'service user';
        const domain = this.config.platform.adminEmail!.split('@')[1];
        p.serviceEmail = `bee-service+${req.slug}@${domain}`;
        const password = `Svc-${randomBytes(18).toString('base64url')}-9z`;
        p.servicePasswordRef = await this.vault.put(`tenant/${req.slug}/service_password`, password);
        await this.factory.createServiceUser(ws, p.serviceEmail, password);
        p.serviceUserCreated = true;
        await done('service user created');
      }

      // 3. the CRM Bee app inside the workspace
      if (!p.appInstalled) {
        current = 'app install';
        await this.factory.installApp(ws, this.config.platform.appUniversalId);
        p.appInstalled = true;
        await done('app installed');
      }

      // 4. tenant provisioning: roles, hardening, configuration, first client admin
      if (!p.provisioned) {
        current = 'tenant provisioning';
        const preset = PIPELINE_PRESETS[req.pipelinePreset];
        const report = await this.provisioning.provision({
          manifestVersion: 1, slug: req.slug, name: req.name, deploymentId: 'shared_01',
          twenty: { workspaceId: ws.workspaceId, baseUrl: ws.url, apiTokenRef: p.apiKeyRef, serviceUser: { email: p.serviceEmail, passwordRef: p.servicePasswordRef } },
          timezone: req.timezone, workingDays: req.workingDays, morningReminderTime: req.morningReminderTime, defaultCurrency: req.defaultCurrency,
          ...(req.defaultCountry ? { defaultCountry: req.defaultCountry } : {}),
          pipeline: preset, teams: req.teams,
          users: [{ displayName: req.adminName, email: req.adminEmail, role: 'client_admin', preferredReminderChannel: 'web', timezone: req.timezone }],
        }, { actor: `operator:${operator.id}` });
        p.tenantId = report.tenantId;
        p.provisioned = true;
        await this.save(req.slug, { tenantId: report.tenantId });
        if (report.access && !report.access.ok) throw new UserFacingError(`Twenty access could not be configured: ${report.access.error}`, 'PROVISION_FAILED');
        await done('tenant provisioned');
      }

      // 5. invite the first client admin (Twenty e-mails a personal link; accepting links the account automatically)
      if (!p.invited?.sent) {
        current = 'invitation';
        const ctx = await this.tenantSvc.getContext(p.tenantId!);
        p.invited = await this.access.inviteMember(ctx, req.adminEmail);
        if (p.invited.sent) {
          const u = (await this.directory.list(p.tenantId!)).find((x) => x.email === req.adminEmail.toLowerCase());
          if (u) await this.directory.markInvited(p.tenantId!, u.id, `operator:${operator.id}`);
          await done('client admin invited');
        } else {
          await this.save(req.slug, { progress: p as unknown as Record<string, unknown> });
        }
      }

      // 6. operators are not members of client workspaces: the provisioning account leaves
      if (!p.platformAccountRemoved && p.serviceUserCreated) {
        current = 'cleanup';
        p.platformAccountRemoved = await this.factory.removePlatformAccount(ws);
        if (p.platformAccountRemoved) await done('provisioning account removed');
      }

      await this.save(req.slug, { state: 'ready', error: null, tenantId: p.tenantId, progress: p as unknown as Record<string, unknown> });
      await this.audit.write(operator, 'company.created', { tenantId: p.tenantId, target: req.slug, metadata: { workspaceUrl: ws.url, adminEmail: req.adminEmail, invitationSent: !!p.invited?.sent } });
      return { state: 'ready', tenantId: p.tenantId!, slug: req.slug, workspaceUrl: ws.url, adminEmail: req.adminEmail, invitation: p.invited ?? { sent: false }, access: null, steps: p.steps.map((s) => s.step) };
    } catch (e) {
      let message = e instanceof Error ? e.message : String(e);
      // Twenty's licence: a server without an Organization (enterprise) key may hold at most 5 workspaces, the operations
      // workspace included. Say so plainly instead of surfacing the raw error.
      const cap = /Cannot create more than (\d+) workspaces/i.exec(message);
      if (cap) message = `this Twenty server is at its limit of ${cap[1]} workspaces (the operations workspace counts as one). More companies need a Twenty Organization key (ENTERPRISE_KEY) on the server, or an existing company must be removed first.`;
      await this.save(req.slug, { state: 'failed', error: `${current}: ${message}`.slice(0, 1000), progress: p as unknown as Record<string, unknown> });
      await this.audit.write(operator, 'company.create_failed', { target: req.slug, result: 'failure', metadata: { step: current, message: message.slice(0, 300) } });
      throw new UserFacingError(`Creating "${req.slug}" stopped at "${current}": ${message}. Fix the cause and submit again — completed steps are kept.`, 'PROVISION_FAILED');
    }
  }
}
