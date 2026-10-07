import { z } from 'zod';

// ──────────────────────────────────────────────────────────────
// NORMALIZED INBOUND EVENT (Section 9)
// Every channel adapter normalizes to this schema.
// ──────────────────────────────────────────────────────────────
export const NormalizedEventSchema = z.object({
  providerEventId: z.string().min(1),
  channel: z.enum(['whatsapp', 'teams', 'dev', 'web', 'email', 'web_form']),
  connectionId: z.string().min(1),
  externalSenderId: z.string().min(1),
  conversationId: z.string().min(1),
  replyToId: z.string().optional(),
  receivedAt: z.string().datetime(),
  messageType: z.enum(['text', 'image', 'audio', 'document', 'interactive', 'card_action', 'status']),
  text: z.string().optional(),
  media: z.array(z.object({
    mediaId: z.string(),
    mimeType: z.string(),
    size: z.number().optional(),
    url: z.string().optional(),
    filename: z.string().optional(),
  })).optional(),
  interactiveResponse: z.object({
    type: z.enum(['button_reply', 'list_reply']),
    id: z.string(),
    title: z.string().optional(),
  }).optional(),
  /** Teams conversation reference for proactive messages (channel-supplied, verified by the activity JWT) */
  conversationRef: z.record(z.unknown()).optional(),
  /** Resolved after channel binding lookup — never from user input */
  tenantId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  correlationId: z.string().optional(),
});

export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

// ──────────────────────────────────────────────────────────────
// PROPOSED ACTION SCHEMAS (Section 9)
// Strict typed union — unknown fields/actions are rejected.
// The LLM proposes; deterministic code validates and executes.
// ──────────────────────────────────────────────────────────────

const PersonFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  phoneE164: z.string().optional(),
  phoneRaw: z.string().optional(),
  title: z.string().optional(),
  companyName: z.string().optional(),
}).strict();

const CompanyFieldsSchema = z.object({
  name: z.string().min(1),
  website: z.string().url().optional(),
  domain: z.string().optional(),
  address: z.string().optional(),
  country: z.string().optional(),
}).strict();

const OpportunityFieldsSchema = z.object({
  title: z.string().min(1),
  stageId: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  expectedCloseDate: z.string().optional(),
  interest: z.string().optional(),
  source: z.string().optional(),
  lostReason: z.string().optional(),
}).strict();

const NoteFieldsSchema = z.object({
  text: z.string().min(1),
  type: z.enum(['observation', 'meeting_note', 'transcript', 'enquiry']).optional(),
  eventTime: z.string().datetime().optional(),
}).strict();

const TaskFieldsSchema = z.object({
  title: z.string().min(1),
  type: z.enum(['follow_up', 'meeting', 'call', 'task']),
  dueDate: z.string().optional(),
  dueTime: z.string().optional(),
  timezone: z.string().optional(),
  duration: z.number().optional(),
  location: z.string().optional(),
  assigneeId: z.string().optional(),
}).strict();

const ExistingRefsSchema = z.object({
  personId: z.string().min(1).optional(),
  companyId: z.string().min(1).optional(),
  opportunityId: z.string().min(1).optional(),
}).strict();

/** Fields filled on an existing person — only previously blank values (CAP-06). */
const PersonFillSchema = z.object({
  email: z.string().email().optional(),
  phoneE164: z.string().optional(),
  phoneRaw: z.string().optional(),
  title: z.string().optional(),
  companyId: z.string().optional(),
}).strict();

export const CaptureLeadActionSchema = z.object({
  type: z.literal('capture_lead'),
  person: PersonFieldsSchema.optional(),
  company: CompanyFieldsSchema.optional(),
  opportunity: OpportunityFieldsSchema.optional(),
  notes: z.array(NoteFieldsSchema).default([]),
  tasks: z.array(TaskFieldsSchema).default([]),
  /** Server-chosen link-to-existing decisions; never taken from model output */
  existing: ExistingRefsSchema.optional(),
  personFill: PersonFillSchema.optional(),
  /** Owner chosen by server rules (e.g. intake assignment); defaults to the confirming user */
  ownerUserId: z.string().uuid().optional(),
  sourceAttribution: z.record(z.string()).optional(),
}).strict();

export const UpdateStageActionSchema = z.object({
  type: z.literal('update_stage'),
  opportunityId: z.string().min(1),
  newStageId: z.string().min(1),
  expectedVersion: z.string().optional(),
  lostReason: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
}).strict();

export const AddNoteActionSchema = z.object({
  type: z.literal('add_note'),
  targetType: z.enum(['person', 'company', 'opportunity']),
  targetId: z.string().min(1),
  note: NoteFieldsSchema,
  expectedVersion: z.string().optional(),
}).strict();

export const CreateTaskActionSchema = z.object({
  type: z.literal('create_task'),
  targetType: z.enum(['person', 'opportunity']).optional(),
  targetId: z.string().optional(),
  task: TaskFieldsSchema,
}).strict();

export const RescheduleActionSchema = z.object({
  type: z.literal('reschedule'),
  taskId: z.string().min(1),
  newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  newTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().optional(),
  expectedVersion: z.string().optional(),
}).strict();

export const AssignActionSchema = z.object({
  type: z.literal('assign'),
  targetType: z.enum(['person', 'company', 'opportunity', 'task']),
  targetId: z.string().min(1),
  newOwnerUserId: z.string().uuid(),
  expectedVersion: z.string().optional(),
  /** Open tasks reassigned together with the record (previewed to the user) */
  cascadeTaskIds: z.array(z.string()).default([]),
}).strict();

export const ArchiveActionSchema = z.object({
  type: z.literal('archive'),
  targetType: z.enum(['person', 'company', 'opportunity']),
  targetId: z.string().min(1),
  expectedVersion: z.string().optional(),
  /** Open tasks linked to the record leave reminders with it */
  cascadeTaskIds: z.array(z.string()).default([]),
}).strict();

export const RestoreActionSchema = z.object({
  type: z.literal('restore'),
  targetType: z.enum(['person', 'company', 'opportunity']),
  targetId: z.string().min(1),
  expectedVersion: z.string().optional(),
}).strict();

/**
 * Executable actions — the ONLY thing the operation journal will run (SEC-02).
 * IDs here are always chosen by server code after authorization; they are never
 * copied from model output (see LlmIntentSchema for what a model may emit).
 */
export const AllowedActionSchema = z.discriminatedUnion('type', [
  CaptureLeadActionSchema,
  UpdateStageActionSchema,
  AddNoteActionSchema,
  CreateTaskActionSchema,
  RescheduleActionSchema,
  AssignActionSchema,
  ArchiveActionSchema,
  RestoreActionSchema,
]);

export type AllowedAction = z.infer<typeof AllowedActionSchema>;
export type CaptureLeadAction = z.infer<typeof CaptureLeadActionSchema>;
export type ActionType = AllowedAction['type'];

// ──────────────────────────────────────────────────────────────
// MODEL-FACING SCHEMA
// What an LLM is allowed to say. No tenant, user, record IDs, roles, tools or SQL
// can be expressed. Unknown fields are rejected by .strict().
// ──────────────────────────────────────────────────────────────
const LlmText = z.string().max(2000);

export const LlmPersonSchema = z.object({
  name: LlmText.optional(),
  title: LlmText.optional(),
  email: LlmText.optional(),
  phone: LlmText.optional(),
  companyName: LlmText.optional(),
  website: LlmText.optional(),
  address: LlmText.optional(),
}).strict();

export const LlmTaskSchema = z.object({
  title: LlmText,
  type: z.enum(['follow_up', 'meeting', 'call', 'task']),
  /** Natural-language date ("next Tuesday") — resolved by deterministic code, never by the model */
  dateExpression: LlmText.optional(),
  timeExpression: LlmText.optional(),
  location: LlmText.optional(),
}).strict();

export const LlmIntentSchema = z.object({
  intent: z.enum([
    'capture_lead', 'search', 'update_stage', 'add_note', 'create_task', 'reschedule',
    'assign', 'archive', 'restore', 'summary', 'clarify', 'smalltalk', 'unknown',
  ]),
  person: LlmPersonSchema.optional(),
  companyName: LlmText.optional(),
  opportunityTitle: LlmText.optional(),
  interest: LlmText.optional(),
  amount: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  notes: z.array(LlmText).max(5).optional(),
  tasks: z.array(LlmTaskSchema).max(5).optional(),
  /** Free-text name of an existing record the user refers to; resolved server-side */
  targetQuery: LlmText.optional(),
  newStage: LlmText.optional(),
  newOwnerName: LlmText.optional(),
  dateExpression: LlmText.optional(),
  timeExpression: LlmText.optional(),
  summaryType: z.enum(['today_meetings', 'overdue_followups', 'company_summary', 'team_pipeline', 'won_this_month', 'my_pipeline']).optional(),
  clarification: LlmText.optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

export type LlmIntent = z.infer<typeof LlmIntentSchema>;

/** Card OCR result with per-field evidence (CAP-03). */
export const CardExtractionSchema = z.object({
  name: LlmText.optional(),
  title: LlmText.optional(),
  company: LlmText.optional(),
  phones: z.array(LlmText).max(5).default([]),
  email: LlmText.optional(),
  website: LlmText.optional(),
  address: LlmText.optional(),
  legible: z.boolean().default(true),
  uncertainFields: z.array(z.string()).default([]),
}).strict();
export type CardExtraction = z.infer<typeof CardExtractionSchema>;

/** Form-email fallback extraction with evidence (IN-04). */
export const EmailExtractionSchema = z.object({
  name: LlmText.optional(),
  email: LlmText.optional(),
  phone: LlmText.optional(),
  company: LlmText.optional(),
  message: z.string().max(5000).optional(),
  evidence: z.record(z.string()).default({}),
}).strict();
export type EmailExtraction = z.infer<typeof EmailExtractionSchema>;
