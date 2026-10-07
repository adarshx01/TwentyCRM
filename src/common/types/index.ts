import type { PipelineConfig, QuotaLimits, RetentionPolicy, TenantSettings, UserRole } from '../../database/schema';

/**
 * Tenant context resolved server-side from verified channel bindings.
 * Never derived from user input, prompts, or model output (TEN-01).
 */
export interface TenantContext {
  tenantId: string;
  tenantSlug: string;
  twentyWorkspaceId: string;
  twentyBaseUrl?: string;
  twentyApiTokenRef: string;
  timezone: string;
  defaultCurrency: string;
  workingDays: number[];
  morningReminderTime: string;
  pipeline: PipelineConfig;
  settings: TenantSettings;
  quotaLimits: QuotaLimits;
  retention: RetentionPolicy;
  configVersion: number;
}

/** Authorization context for the acting employee (Section 4). */
export interface UserContext {
  userId: string;
  tenantId: string;
  displayName: string;
  role: UserRole;
  teamId?: string;
  managedTeamIds: string[];
  twentyMemberId?: string;
  timezone: string;
  morningReminderTime?: string;
  preferredReminderChannel?: string;
  dualDelivery: boolean;
}

export interface RequestContext {
  tenant: TenantContext;
  user: UserContext;
  correlationId: string;
  channel: string;
  conversationId: string;
}

export type OperationState = 'pending' | 'in_progress' | 'committed' | 'failed' | 'needs_repair';

/** `dev` is the local development chat (DEV_CHANNEL=1, never in production). */
export type ChannelName = 'whatsapp' | 'teams' | 'dev' | 'web';
