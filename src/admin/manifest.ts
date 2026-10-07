import { z } from 'zod';

const Stage = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,38}$/, 'stage ids are stable lowercase identifiers'),
  label: z.string().min(1).max(60),
  terminal: z.enum(['won', 'lost']).optional(),
  requiredFields: z.array(z.enum(['amount', 'lostReason', 'closeDate'])).optional(),
}).strict();

const UserSpec = z.object({
  displayName: z.string().min(1).max(255),
  email: z.string().email().optional(),
  role: z.enum(['salesperson', 'manager', 'cxo', 'client_admin']),
  twentyMemberId: z.string().min(1).optional(),
  teamId: z.string().optional(),
  managedTeamIds: z.array(z.string()).optional(),
  timezone: z.string().optional(),
  morningReminderTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  preferredReminderChannel: z.enum(['whatsapp', 'teams', 'dev', 'web']).optional(),
  dualDelivery: z.boolean().optional(),
}).strict().refine((u) => u.email || u.twentyMemberId, { message: 'a user needs an email or twentyMemberId as its stable key' });

const IntakeSpec = z.object({
  sourceId: z.string().min(1).max(100),
  type: z.enum(['email_forward', 'mailbox_poll', 'webhook']),
  formLabel: z.string().optional(),
  intakeAlias: z.string().email().optional(),
  parsingRules: z.object({
    parserVersion: z.string(), allowedSenders: z.array(z.string()).optional(), subjectPattern: z.string().max(200).optional(),
    fieldAliases: z.object({ name: z.array(z.string()), email: z.array(z.string()), phone: z.array(z.string()), company: z.array(z.string()), message: z.array(z.string()), submissionId: z.array(z.string()) }),
    requiredFields: z.array(z.enum(['name', 'company', 'email', 'phone', 'message'])), replyToIsVisitor: z.boolean().optional(), templateMarkers: z.array(z.string()), defaultCountry: z.string().length(2).optional(),
  }),
  crmRouting: z.object({ initialStage: z.string(), sourceTag: z.string(), ownerEmail: z.string().email().optional(), roundRobinEmails: z.array(z.string().email()).optional(), teamId: z.string().optional(), mode: z.enum(['auto', 'review']), repeatPolicy: z.enum(['review', 'append_to_open', 'create_new']).optional() }),
  followUp: z.object({ taskDelayWorkingDays: z.number().int().min(0).max(30).optional(), notify: z.boolean().optional() }).optional(),
  webhookSecretRef: z.string().optional(),
  mailbox: z.object({ provider: z.literal('graph'), mailboxId: z.string(), folderId: z.string().optional(), tokenRef: z.string() }).optional(),
}).strict();

/** Versioned tenant manifest (CFG-01..CFG-04). Contains secret REFERENCES only, never secret values. */
export const TenantManifestSchema = z.object({
  manifestVersion: z.literal(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}$/),
  name: z.string().min(1).max(255),
  deploymentId: z.string().default('shared_01'),
  twenty: z.object({ workspaceId: z.string().min(1), baseUrl: z.string().url().optional(), apiTokenRef: z.string().regex(/^(env|file|gcp-sm):/, 'use a secret reference such as env:NAME or gcp-sm:projects/…'), webhookSecretRef: z.string().regex(/^(env|file|gcp-sm):/).optional() }).strict(),
  timezone: z.string().default('UTC').refine((z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } }, 'unknown IANA timezone'),
  workingDays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  morningReminderTime: z.string().regex(/^\d{2}:\d{2}$/).default('09:00'),
  defaultCurrency: z.string().length(3).default('INR'),
  defaultCountry: z.string().length(2).optional(),
  pipeline: z.object({ stages: z.array(Stage).min(2), defaultInitialStage: z.string() }).strict(),
  /** Required to remove a stage that has active records: stageId → target stageId (CFG-04) */
  stageMigrations: z.record(z.string()).optional(),
  notificationUserEmail: z.string().email().optional(),
  channels: z.object({ whatsapp: z.object({ accessTokenRef: z.string().regex(/^(env|file|gcp-sm):/) }).strict().optional() }).strict().optional(),
  quotas: z.object({ maxUploadsPerMinute: z.number().optional(), maxRemindersPerMinute: z.number().optional(), maxMessagesPerMinute: z.number().optional(), maxAiJobsInFlight: z.number().optional() }).optional(),
  retention: z.object({ draftExpirySeconds: z.number().optional(), mediaRetentionDays: z.number().optional(), auditRetentionDays: z.number().optional(), rawEmailRetentionDays: z.number().optional(), reviewRetentionDays: z.number().optional() }).optional(),
  users: z.array(UserSpec).default([]),
  intakeSources: z.array(IntakeSpec).default([]),
}).strict().superRefine((m, ctx) => {
  const ids = m.pipeline.stages.map((s) => s.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate stage ids' });
  if (!ids.includes(m.pipeline.defaultInitialStage)) ctx.addIssue({ code: 'custom', message: 'defaultInitialStage must be a stage id' });
  if (m.pipeline.stages.find((s) => s.id === m.pipeline.defaultInitialStage)?.terminal) ctx.addIssue({ code: 'custom', message: 'the initial stage cannot be a terminal stage' });
  if (!m.pipeline.stages.some((s) => s.terminal === 'won') || !m.pipeline.stages.some((s) => s.terminal === 'lost')) ctx.addIssue({ code: 'custom', message: 'pipeline needs one won and one lost terminal stage' });
});
export type TenantManifest = z.infer<typeof TenantManifestSchema>;
