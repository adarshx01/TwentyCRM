import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DbService } from '../database/db.service';
import { tenants } from '../database/schema';
import { TenantProvisioningService, type ProvisionReport } from './tenant-provisioning.service';
import { UserFacingError } from '../common/errors';

/** What a client admin may change about their own tenant (CFG-01..04). Workspace binding and secrets are operator-only. */
export const ConfigPatchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  timezone: z.string().optional(),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
  morningReminderTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  defaultCurrency: z.string().length(3).optional(),
  defaultCountry: z.string().length(2).optional(),
  pipeline: z.object({
    stages: z.array(z.object({ id: z.string(), label: z.string().min(1).max(60), terminal: z.enum(['won', 'lost']).optional(), requiredFields: z.array(z.enum(['amount', 'lostReason', 'closeDate'])).optional() }).strict()).min(2),
    defaultInitialStage: z.string(),
  }).strict().optional(),
  stageMigrations: z.record(z.string()).optional(),
}).strict();
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

/**
 * Client-admin configuration. Edits go through the SAME versioned provisioning path an operator manifest uses, so stage
 * ids stay stable, a stage with active records cannot vanish without a previewed migration (CFG-04), and every change
 * bumps the configuration version and is audited.
 */
@Injectable()
export class TenantConfigService {
  constructor(private readonly db: DbService, private readonly provisioning: TenantProvisioningService) {}

  private async row(tenantId: string) {
    const [t] = await this.db.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!t) throw new UserFacingError('Tenant not found.', 'NOT_FOUND');
    return t;
  }

  async get(tenantId: string) {
    const t = await this.row(tenantId);
    return {
      name: t.name, timezone: t.timezone, workingDays: t.workingDays, morningReminderTime: t.morningReminderTime, defaultCurrency: t.defaultCurrency,
      defaultCountry: t.settings?.defaultCountry ?? null, configVersion: t.configVersion,
      pipeline: { defaultInitialStage: t.pipelineConfig?.defaultInitialStage ?? 'new', version: t.pipelineConfig?.version ?? 1, stages: (t.pipelineConfig?.stages ?? []).map((s) => ({ id: s.id, label: s.label, terminal: s.terminalType, requiredFields: s.requiredFields })) },
    };
  }

  async update(tenantId: string, patch: ConfigPatch, actor: string, dryRun = false): Promise<ProvisionReport> {
    const t = await this.row(tenantId);
    const cur = await this.get(tenantId);
    const manifest = {
      manifestVersion: 1 as const, slug: t.slug, name: patch.name ?? t.name, deploymentId: t.deploymentId,
      twenty: { workspaceId: t.twentyWorkspaceId, ...(t.twentyBaseUrl ? { baseUrl: t.twentyBaseUrl } : {}), apiTokenRef: t.twentyApiTokenRef, ...(t.settings?.twentyWebhookSecretRef ? { webhookSecretRef: t.settings.twentyWebhookSecretRef } : {}), ...(t.settings?.twentyServiceUser ? { serviceUser: t.settings.twentyServiceUser } : {}) },
      timezone: patch.timezone ?? t.timezone, workingDays: patch.workingDays ?? t.workingDays, morningReminderTime: patch.morningReminderTime ?? t.morningReminderTime,
      defaultCurrency: patch.defaultCurrency ?? t.defaultCurrency, ...((patch.defaultCountry ?? cur.defaultCountry) ? { defaultCountry: patch.defaultCountry ?? cur.defaultCountry! } : {}),
      pipeline: patch.pipeline ?? { defaultInitialStage: cur.pipeline.defaultInitialStage, stages: cur.pipeline.stages.map((s) => ({ id: s.id, label: s.label, ...(s.terminal ? { terminal: s.terminal } : {}), ...(s.requiredFields?.length ? { requiredFields: s.requiredFields } : {}) })) },
      ...(patch.stageMigrations ? { stageMigrations: patch.stageMigrations } : {}),
      ...(t.settings?.whatsappAccessTokenRef ? { channels: { whatsapp: { accessTokenRef: t.settings.whatsappAccessTokenRef } } } : {}),
      ...(t.quotaLimits ? { quotas: t.quotaLimits } : {}), ...(t.retentionPolicy ? { retention: t.retentionPolicy } : {}),
      users: [], intakeSources: [],
    };
    return this.provisioning.provision(manifest, { dryRun, actor });
  }
}
