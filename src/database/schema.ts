import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigint,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => ts('created_at').defaultNow().notNull();
const updatedAt = () => ts('updated_at').defaultNow().notNull();

// ──────────────────────────────────────────────────────────────
// TYPE DEFINITIONS
// ──────────────────────────────────────────────────────────────

export type UserRole = 'salesperson' | 'manager' | 'cxo' | 'client_admin' | 'platform_operator';

export type DraftState =
  | 'collecting'
  | 'awaiting_confirmation'
  | 'committing'
  | 'committed'
  | 'cancelled'
  | 'expired'
  | 'needs_repair';

export type OperationStatus = 'pending' | 'in_progress' | 'committed' | 'failed' | 'needs_repair';

export interface PipelineStage {
  id: string;
  label: string;
  order: number;
  isTerminal: boolean;
  terminalType?: 'won' | 'lost';
  requiredFields?: string[];
}

export interface PipelineConfig {
  stages: PipelineStage[];
  defaultInitialStage: string;
  version: number;
}

export interface QuotaLimits {
  maxUploadsPerMinute?: number;
  maxRemindersPerMinute?: number;
  maxMessagesPerMinute?: number;
  maxAiJobsInFlight?: number;
}

export interface RetentionPolicy {
  draftExpirySeconds?: number;
  mediaRetentionDays?: number;
  abandonedMediaHours?: number;
  auditRetentionDays?: number;
  rawEmailRetentionDays?: number;
  reviewRetentionDays?: number;
}

export interface TenantSettings {
  /** ISO-3166 alpha-2 used only as a parsing hint for national phone numbers */
  defaultCountry?: string;
  /** Internal Teams destination (CFG-03 notification destination) */
  notificationDestination?: { channel: 'whatsapp' | 'teams'; userId?: string; teamsChannelId?: string };
  reminderCutoffMinutes?: number;
  /** Secret reference for verifying Twenty change-event webhooks (SYNC-02) */
  twentyWebhookSecretRef?: string;
  /** Dedicated client WhatsApp number: secret reference for its access token (WA-01); default is the platform token */
  whatsappAccessTokenRef?: string;
  /** Teams channel reminders allowed only when every member is authorized (TM-04) */
  teamsChannelDigestAllowed?: boolean;
}

export interface ProposedAction {
  type: string;
  [key: string]: unknown;
}

export interface MediaRef {
  key: string;
  mimeType: string;
  size: number;
  source: 'card' | 'voice' | 'attachment';
  sourceEventId?: string;
}

export interface OperationStep {
  key: string;
  kind: string;
  status: 'pending' | 'in_progress' | 'committed' | 'failed' | 'skipped';
  payload?: Record<string, unknown>;
  externalId?: string;
  attemptedAt?: string;
  completedAt?: string;
  attempts?: number;
  error?: string;
}

export interface IntakeTimestamps {
  received?: string;
  parsed?: string;
  saved?: string;
  review?: string;
  failed?: string;
}

// ──────────────────────────────────────────────────────────────
// TENANTS (TEN-01..TEN-05, CFG-01..CFG-04)
// ──────────────────────────────────────────────────────────────
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 63 }).unique().notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  deploymentId: varchar('deployment_id', { length: 63 }).notNull().default('shared_01'),
  twentyWorkspaceId: varchar('twenty_workspace_id', { length: 255 }).notNull(),
  /** Base URL of the tenant's Twenty workspace (subdomain). Falls back to TWENTY_API_URL. */
  twentyBaseUrl: varchar('twenty_base_url', { length: 512 }),
  /** Secret-manager reference — never the token itself (CFG-03) */
  twentyApiTokenRef: varchar('twenty_api_token_ref', { length: 512 }).notNull(),
  timezone: varchar('timezone', { length: 63 }).notNull().default('UTC'),
  workingDays: jsonb('working_days').$type<number[]>().notNull().default([1, 2, 3, 4, 5]),
  morningReminderTime: varchar('morning_reminder_time', { length: 5 }).notNull().default('09:00'),
  defaultCurrency: varchar('default_currency', { length: 3 }).notNull().default('INR'),
  pipelineConfig: jsonb('pipeline_config').$type<PipelineConfig>(),
  settings: jsonb('settings').$type<TenantSettings>().notNull().default({}),
  configVersion: integer('config_version').notNull().default(1),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  quotaLimits: jsonb('quota_limits').$type<QuotaLimits>(),
  retentionPolicy: jsonb('retention_policy').$type<RetentionPolicy>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ──────────────────────────────────────────────────────────────
// USERS (IAM-01..IAM-05)
// ──────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  twentyMemberId: varchar('twenty_member_id', { length: 255 }),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  role: varchar('role', { length: 20 }).$type<UserRole>().notNull(),
  teamId: varchar('team_id', { length: 255 }),
  managedTeamIds: jsonb('managed_team_ids').$type<string[]>().notNull().default([]),
  preferredReminderChannel: varchar('preferred_reminder_channel', { length: 20 }),
  dualDelivery: boolean('dual_delivery').notNull().default(false),
  timezone: varchar('user_timezone', { length: 63 }),
  morningReminderTime: varchar('user_morning_time', { length: 5 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  revokedAt: ts('revoked_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  tenantIdx: index('users_tenant_idx').on(t.tenantId),
  statusIdx: index('users_status_idx').on(t.tenantId, t.status),
  memberIdx: uniqueIndex('users_member_uq').on(t.tenantId, t.twentyMemberId).where(sql`twenty_member_id is not null`),
}));

// ──────────────────────────────────────────────────────────────
// CHANNEL BINDINGS (IAM-01, IAM-03, IAM-04)
// A person with several client memberships has several rows.
// ──────────────────────────────────────────────────────────────
export const channelBindings = pgTable('channel_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  channel: varchar('channel', { length: 20 }).notNull(),
  /** E.164 phone (WhatsApp) or Entra object ID (Teams) */
  externalId: varchar('external_id', { length: 512 }).notNull(),
  /** WhatsApp service phone-number ID, or Entra tenant ID for Teams */
  connectionId: varchar('connection_id', { length: 512 }).notNull(),
  conversationRef: jsonb('conversation_ref'),
  lastInboundAt: ts('last_inbound_at'),
  optedOut: boolean('opted_out').notNull().default(false),
  enrolledBy: uuid('enrolled_by'),
  enrolledAt: ts('enrolled_at').defaultNow().notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
}, (t) => ({
  uniqueBinding: unique('channel_bindings_unique').on(t.channel, t.connectionId, t.externalId, t.tenantId),
  tenantIdx: index('channel_bindings_tenant_idx').on(t.tenantId),
  lookupIdx: index('channel_bindings_lookup_idx').on(t.channel, t.connectionId, t.externalId),
  userIdx: index('channel_bindings_user_idx').on(t.userId),
}));

export const enrollments = pgTable('enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  codeHash: varchar('code_hash', { length: 64 }).notNull().unique(),
  channel: varchar('channel', { length: 20 }).notNull(),
  /** Expected sender for the code, when the administrator knows it (e.g. phone) */
  expectedExternalId: varchar('expected_external_id', { length: 512 }),
  createdBy: varchar('created_by', { length: 255 }).notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
}, (t) => ({ tenantIdx: index('enrollments_tenant_idx').on(t.tenantId) }));

/** Active workspace selection for people with several memberships (IAM-04). */
export const conversationSessions = pgTable('conversation_sessions', {
  channel: varchar('channel', { length: 20 }).notNull(),
  connectionId: varchar('connection_id', { length: 512 }).notNull(),
  externalId: varchar('external_id', { length: 512 }).notNull(),
  activeTenantId: uuid('active_tenant_id'),
  /** Pending numbered choice offered to the user, ids in display order */
  pendingChoices: jsonb('pending_choices').$type<string[]>(),
  updatedAt: updatedAt(),
}, (t) => ({ pk: unique('conversation_sessions_pk').on(t.channel, t.connectionId, t.externalId) }));

// ──────────────────────────────────────────────────────────────
// DRAFTS (ACT-01..ACT-05)
// ──────────────────────────────────────────────────────────────
export const drafts = pgTable('drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  conversationId: varchar('conversation_id', { length: 512 }).notNull(),
  channel: varchar('channel', { length: 20 }).notNull(),
  kind: varchar('kind', { length: 30 }).notNull().default('capture'),
  state: varchar('state', { length: 25 }).$type<DraftState>().notNull().default('collecting'),
  version: integer('version').notNull().default(1),
  contentHash: varchar('content_hash', { length: 64 }),
  proposedActions: jsonb('proposed_actions').$type<ProposedAction[]>().notNull().default([]),
  extractedData: jsonb('extracted_data').$type<Record<string, unknown>>(),
  sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull().default([]),
  /** Message ID of the latest preview, used to link replies (CAP-02) */
  previewMessageId: varchar('preview_message_id', { length: 255 }),
  operationId: uuid('operation_id'),
  mediaRefs: jsonb('media_refs').$type<MediaRef[]>().notNull().default([]),
  expiresAt: ts('expires_at'),
  committedAt: ts('committed_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  tenantUserIdx: index('drafts_tenant_user_idx').on(t.tenantId, t.userId),
  conversationIdx: index('drafts_conversation_idx').on(t.conversationId, t.state),
  expiryIdx: index('drafts_expiry_idx').on(t.expiresAt).where(sql`state in ('collecting','awaiting_confirmation')`),
}));

// ──────────────────────────────────────────────────────────────
// OPERATIONS (ACT-04, ACT-05) — journal with step-level tracking
// ──────────────────────────────────────────────────────────────
export const operations = pgTable('operations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  draftId: uuid('draft_id'),
  draftVersion: integer('draft_version'),
  type: varchar('type', { length: 50 }).notNull(),
  channel: varchar('channel', { length: 20 }),
  state: varchar('state', { length: 20 }).$type<OperationStatus>().notNull().default('pending'),
  /** Frozen, validated actions confirmed by the user */
  actions: jsonb('actions').$type<ProposedAction[]>().notNull().default([]),
  steps: jsonb('steps').$type<OperationStep[]>().notNull().default([]),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).unique(),
  sourceEventId: varchar('source_event_id', { length: 255 }),
  result: jsonb('result'),
  errorInfo: jsonb('error_info'),
  retryCount: integer('retry_count').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(5),
  leaseOwner: varchar('lease_owner', { length: 255 }),
  leaseUntil: ts('lease_until'),
  correlationId: varchar('correlation_id', { length: 255 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  tenantIdx: index('operations_tenant_idx').on(t.tenantId, t.createdAt),
  stateIdx: index('operations_state_idx').on(t.state, t.leaseUntil),
}));

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: varchar('key', { length: 512 }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  operationId: uuid('operation_id'),
  result: jsonb('result'),
  createdAt: createdAt(),
  expiresAt: ts('expires_at').notNull(),
}, (t) => ({ expiryIdx: index('idempotency_expiry_idx').on(t.expiresAt) }));

// ──────────────────────────────────────────────────────────────
// AUDIT LOG (SEC-03) — append-only (enforced by trigger in migration)
// ──────────────────────────────────────────────────────────────
export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id'),
  channel: varchar('channel', { length: 20 }),
  sourceEventId: varchar('source_event_id', { length: 255 }),
  action: varchar('action', { length: 100 }).notNull(),
  resourceType: varchar('resource_type', { length: 50 }),
  resourceId: varchar('resource_id', { length: 255 }),
  changedFields: jsonb('changed_fields'),
  confirmationId: varchar('confirmation_id', { length: 255 }),
  result: varchar('result', { length: 20 }),
  correlationId: varchar('correlation_id', { length: 255 }),
  timestamp: ts('timestamp').defaultNow().notNull(),
  metadata: jsonb('metadata'),
}, (t) => ({
  tenantTimeIdx: index('audit_tenant_time_idx').on(t.tenantId, t.timestamp),
  correlationIdx: index('audit_correlation_idx').on(t.correlationId),
}));

// ──────────────────────────────────────────────────────────────
// SCHEDULES (REM-01..REM-07)
// ──────────────────────────────────────────────────────────────
export const schedules = pgTable('schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  type: varchar('type', { length: 30 }).notNull().default('digest'),
  localDate: varchar('local_date', { length: 10 }).notNull(),
  nextRunUtc: ts('next_run_utc').notNull(),
  timezone: varchar('timezone', { length: 63 }).notNull(),
  digestType: varchar('digest_type', { length: 20 }).notNull().default('morning'),
  /** pending → claimed → dispatched | failed | skipped */
  state: varchar('state', { length: 20 }).notNull().default('pending'),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull().unique(),
  claimedAt: ts('claimed_at'),
  claimedBy: varchar('claimed_by', { length: 255 }),
  completedAt: ts('completed_at'),
  retryCount: integer('retry_count').notNull().default(0),
  errorInfo: jsonb('error_info'),
  createdAt: createdAt(),
}, (t) => ({
  pendingRunIdx: index('schedules_pending_run_idx').on(t.state, t.nextRunUtc),
  tenantUserDateIdx: index('schedules_tenant_user_date_idx').on(t.tenantId, t.userId, t.localDate),
}));

// ──────────────────────────────────────────────────────────────
// DELIVERY STATE (WA-03, AT-09, AT-10)
// pending → sending → sent → delivered → read | failed | ambiguous | deferred
// ──────────────────────────────────────────────────────────────
export const deliveryState = pgTable('delivery_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id'),
  channel: varchar('channel', { length: 20 }).notNull(),
  messageType: varchar('message_type', { length: 30 }).notNull(),
  externalMessageId: varchar('external_message_id', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull().unique(),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  /** Detail held back until the employee replies (template-first, WA-03) */
  deferredPayload: jsonb('deferred_payload').$type<Record<string, unknown>>(),
  sendingAt: ts('sending_at'),
  sentAt: ts('sent_at'),
  deliveredAt: ts('delivered_at'),
  failedAt: ts('failed_at'),
  errorInfo: jsonb('error_info'),
  retryCount: integer('retry_count').notNull().default(0),
  createdAt: createdAt(),
}, (t) => ({
  tenantStatusIdx: index('delivery_tenant_status_idx').on(t.tenantId, t.status),
  externalMsgIdx: index('delivery_external_msg_idx').on(t.externalMessageId),
}));

// ──────────────────────────────────────────────────────────────
// INTAKE (IN-01..IN-12)
// ──────────────────────────────────────────────────────────────
export const intakeSources = pgTable('intake_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'restrict' }),
  sourceId: varchar('source_id', { length: 255 }).unique().notNull(),
  intakeAlias: varchar('intake_alias', { length: 512 }).unique(),
  type: varchar('type', { length: 20 }).notNull(), // email_forward | mailbox_poll | webhook
  formLabel: varchar('form_label', { length: 255 }),
  parsingRules: jsonb('parsing_rules').$type<IntakeParsingRules>().notNull(),
  crmRouting: jsonb('crm_routing').$type<IntakeCrmRouting>().notNull(),
  followUpConfig: jsonb('follow_up_config').$type<IntakeFollowUp>(),
  /** Secret-manager ref for signed direct form events (IN-03) */
  webhookSecretRef: varchar('webhook_secret_ref', { length: 512 }),
  mailbox: jsonb('mailbox').$type<{ provider: 'graph'; mailboxId: string; folderId?: string; tokenRef: string }>(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  configVersion: integer('config_version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface IntakeParsingRules {
  parserVersion: string;
  allowedSenders?: string[];
  subjectPattern?: string;
  /** canonical field → label aliases in the form notification */
  fieldAliases: Record<'name' | 'email' | 'phone' | 'company' | 'message' | 'submissionId', string[]>;
  requiredFields: Array<'name' | 'company' | 'email' | 'phone' | 'message'>;
  /** Use Reply-To as visitor email only when the template says so */
  replyToIsVisitor?: boolean;
  /** Labels that must appear for the template to be considered matched */
  templateMarkers: string[];
  defaultCountry?: string;
}

export interface IntakeCrmRouting {
  initialStage: string;
  sourceTag: string;
  ownerUserId?: string;
  teamId?: string;
  roundRobinUserIds?: string[];
  roundRobinCursor?: number;
  mode: 'auto' | 'review';
  /** review (default) | append_to_open | create_new */
  repeatPolicy?: 'review' | 'append_to_open' | 'create_new';
}

export interface IntakeFollowUp {
  taskDelayWorkingDays?: number;
  notify?: boolean;
}

export const intakeRecords = pgTable('intake_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  sourceId: uuid('source_id').notNull().references(() => intakeSources.id),
  /** received → parsed → review | committing → committed | rejected | failed */
  state: varchar('state', { length: 20 }).notNull().default('received'),
  operationId: uuid('operation_id'),
  deliveryIdempotencyKey: varchar('delivery_idempotency_key', { length: 512 }).notNull().unique(),
  messageId: varchar('message_id', { length: 512 }),
  submissionId: varchar('submission_id', { length: 512 }),
  contentFingerprint: varchar('content_fingerprint', { length: 64 }),
  rawEmailRef: varchar('raw_email_ref', { length: 512 }),
  parsedFields: jsonb('parsed_fields').$type<Record<string, unknown>>(),
  proposedActions: jsonb('proposed_actions').$type<ProposedAction[]>(),
  reviewReason: varchar('review_reason', { length: 255 }),
  reviewedBy: varchar('reviewed_by', { length: 255 }),
  reviewedAt: ts('reviewed_at'),
  /** Twenty Intake Review record ID (IN-11) */
  crmReviewId: varchar('crm_review_id', { length: 255 }),
  authEvidence: jsonb('auth_evidence').$type<Record<string, unknown>>(),
  parserVersion: varchar('parser_version', { length: 20 }),
  timestamps: jsonb('timestamps').$type<IntakeTimestamps>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => ({
  tenantStateIdx: index('intake_tenant_state_idx').on(t.tenantId, t.state),
  submissionIdx: index('intake_submission_idx').on(t.sourceId, t.submissionId),
  messageIdx: index('intake_message_idx').on(t.sourceId, t.messageId),
  fingerprintIdx: index('intake_fingerprint_idx').on(t.sourceId, t.contentFingerprint, t.createdAt),
}));

export const mailboxCheckpoints = pgTable('mailbox_checkpoints', {
  sourceId: uuid('source_id').primaryKey().references(() => intakeSources.id),
  tenantId: uuid('tenant_id').notNull(),
  /** Last fully processed received-time; polling overlaps by a margin */
  checkpoint: ts('checkpoint'),
  health: varchar('health', { length: 20 }).notNull().default('ok'),
  lastError: text('last_error'),
  lastPolledAt: ts('last_polled_at'),
  updatedAt: updatedAt(),
});

// ──────────────────────────────────────────────────────────────
// INBOUND EVENTS (webhook dedup)
// ──────────────────────────────────────────────────────────────
export const inboundEvents = pgTable('inbound_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerEventId: varchar('provider_event_id', { length: 512 }).notNull(),
  channel: varchar('channel', { length: 20 }).notNull(),
  tenantId: uuid('tenant_id'),
  userId: uuid('user_id'),
  eventType: varchar('event_type', { length: 50 }),
  /** Normalized event, kept until processed + retention so the worker can run after durable acceptance */
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  processedAt: ts('processed_at'),
  correlationId: varchar('correlation_id', { length: 255 }),
  createdAt: createdAt(),
}, (t) => ({
  dedupIdx: unique('inbound_events_dedup').on(t.channel, t.providerEventId),
  createdIdx: index('inbound_events_created_idx').on(t.createdAt),
}));

// ──────────────────────────────────────────────────────────────
// CRM INDEX + STAGE HISTORY (SYNC-01..03) — operational index only,
// never an editable copy of the pipeline.
// ──────────────────────────────────────────────────────────────
export const crmIndex = pgTable('crm_index', {
  tenantId: uuid('tenant_id').notNull(),
  entity: varchar('entity', { length: 30 }).notNull(), // opportunity | task
  externalId: varchar('external_id', { length: 255 }).notNull(),
  ownerMemberId: varchar('owner_member_id', { length: 255 }),
  teamId: varchar('team_id', { length: 255 }),
  stageId: varchar('stage_id', { length: 100 }),
  status: varchar('status', { length: 30 }),
  dueAt: ts('due_at'),
  archived: boolean('archived').notNull().default(false),
  remoteUpdatedAt: ts('remote_updated_at'),
  lastSeenAt: ts('last_seen_at').defaultNow().notNull(),
}, (t) => ({
  pk: unique('crm_index_pk').on(t.tenantId, t.entity, t.externalId),
}));

export const stageHistory = pgTable('stage_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  opportunityId: varchar('opportunity_id', { length: 255 }).notNull(),
  fromStageId: varchar('from_stage_id', { length: 100 }),
  toStageId: varchar('to_stage_id', { length: 100 }).notNull(),
  terminalType: varchar('terminal_type', { length: 10 }),
  changedAt: ts('changed_at').notNull(),
  source: varchar('source', { length: 20 }).notNull(), // chat | intake | reconciliation
  amountMicros: bigint('amount_micros', { mode: 'number' }),
  currency: varchar('currency', { length: 3 }),
  createdAt: createdAt(),
}, (t) => ({
  oppIdx: index('stage_history_opp_idx').on(t.tenantId, t.opportunityId, t.changedAt),
  dedupIdx: uniqueIndex('stage_history_dedup').on(t.tenantId, t.opportunityId, t.toStageId, t.changedAt),
}));

export const reconciliationState = pgTable('reconciliation_state', {
  tenantId: uuid('tenant_id').notNull(),
  entity: varchar('entity', { length: 30 }).notNull(),
  checkpoint: ts('checkpoint'),
  lastRunAt: ts('last_run_at'),
  lastError: text('last_error'),
}, (t) => ({ pk: unique('reconciliation_state_pk').on(t.tenantId, t.entity) }));

// ──────────────────────────────────────────────────────────────
// MEDIA, USAGE, DEAD LETTERS
// ──────────────────────────────────────────────────────────────
export const mediaObjects = pgTable('media_objects', {
  key: varchar('key', { length: 512 }).primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  kind: varchar('kind', { length: 20 }).notNull(), // card | voice | raw_email
  mimeType: varchar('mime_type', { length: 100 }).notNull(),
  size: integer('size').notNull(),
  draftId: uuid('draft_id'),
  /** Set when the owning draft is confirmed; retention counts from here */
  confirmedAt: ts('confirmed_at'),
  deleteAfter: ts('delete_after'),
  deletedAt: ts('deleted_at'),
  createdAt: createdAt(),
}, (t) => ({ cleanupIdx: index('media_cleanup_idx').on(t.deletedAt, t.deleteAfter) }));

export const usageEvents = pgTable('usage_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  kind: varchar('kind', { length: 30 }).notNull(), // llm_tokens | stt_minutes | vision_calls | media_bytes | messages
  quantity: bigint('quantity', { mode: 'number' }).notNull(),
  provider: varchar('provider', { length: 50 }),
  occurredAt: ts('occurred_at').defaultNow().notNull(),
}, (t) => ({ tenantKindIdx: index('usage_tenant_kind_idx').on(t.tenantId, t.kind, t.occurredAt) }));

export const deadLetters = pgTable('dead_letters', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'),
  queue: varchar('queue', { length: 100 }).notNull(),
  jobId: varchar('job_id', { length: 64 }),
  payload: jsonb('payload'),
  error: text('error'),
  correlationId: varchar('correlation_id', { length: 255 }),
  resolvedAt: ts('resolved_at'),
  createdAt: createdAt(),
}, (t) => ({ openIdx: index('dead_letters_open_idx').on(t.resolvedAt, t.createdAt) }));

/** Tables carrying tenant_id that must be protected by RLS (TEN-03). */
export const RLS_TABLES = [
  'users', 'channel_bindings', 'enrollments', 'drafts', 'operations', 'idempotency_keys',
  'audit_log', 'schedules', 'delivery_state', 'intake_sources', 'intake_records',
  'mailbox_checkpoints', 'crm_index', 'stage_history', 'reconciliation_state',
  'media_objects', 'usage_events',
] as const;
