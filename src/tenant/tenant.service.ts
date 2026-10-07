import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DbService } from '../database/db.service';
import { tenants, type PipelineConfig } from '../database/schema';
import type { TenantContext } from '../common/types';
import { UserFacingError } from '../common/errors';

export const DEFAULT_PIPELINE: PipelineConfig = {
  version: 1,
  defaultInitialStage: 'new',
  stages: [
    { id: 'new', label: 'New', order: 1, isTerminal: false },
    { id: 'qualified', label: 'Qualified', order: 2, isTerminal: false },
    { id: 'meeting', label: 'Meeting', order: 3, isTerminal: false },
    { id: 'proposal', label: 'Proposal', order: 4, isTerminal: false },
    { id: 'negotiation', label: 'Negotiation', order: 5, isTerminal: false },
    { id: 'won', label: 'Won', order: 6, isTerminal: true, terminalType: 'won' },
    { id: 'lost', label: 'Lost', order: 7, isTerminal: true, terminalType: 'lost' },
  ],
};

type TenantRow = typeof tenants.$inferSelect;

export function toTenantContext(row: TenantRow, defaultTwentyUrl?: string): TenantContext {
  return {
    tenantId: row.id,
    tenantSlug: row.slug,
    twentyWorkspaceId: row.twentyWorkspaceId,
    twentyBaseUrl: row.twentyBaseUrl ?? defaultTwentyUrl,
    twentyApiTokenRef: row.twentyApiTokenRef,
    timezone: row.timezone,
    defaultCurrency: row.defaultCurrency,
    workingDays: row.workingDays,
    morningReminderTime: row.morningReminderTime,
    pipeline: row.pipelineConfig ?? DEFAULT_PIPELINE,
    settings: row.settings ?? {},
    quotaLimits: row.quotaLimits ?? {},
    retention: row.retentionPolicy ?? {},
    configVersion: row.configVersion,
  };
}

/** Tenant registry access (TEN-02). The tenants table is not tenant-scoped by RLS. */
@Injectable()
export class TenantService {
  private cache = new Map<string, { ctx: TenantContext; expires: number }>();

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async getContext(tenantId: string): Promise<TenantContext> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expires > Date.now()) return hit.ctx;
    const [row] = await this.db.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!row || row.status !== 'active') throw new UserFacingError('This workspace is not available.', 'TENANT_INACTIVE');
    const ctx = toTenantContext(row, this.config.twenty.apiUrl);
    this.cache.set(tenantId, { ctx, expires: Date.now() + 15_000 });
    return ctx;
  }

  /** Tenant owning a Twenty workspace (1:1, TEN-02). Inactive tenants resolve to null. */
  async findByWorkspace(workspaceId: string): Promise<TenantContext | null> {
    const [row] = await this.db.db.select({ id: tenants.id, status: tenants.status }).from(tenants).where(eq(tenants.twentyWorkspaceId, workspaceId));
    if (!row || row.status !== 'active') return null;
    return this.getContext(row.id);
  }

  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  async listActiveIds(): Promise<string[]> {
    const rows = await this.db.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
    return rows.map((r) => r.id);
  }
}
