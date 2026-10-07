import type { TenantContext } from '../common/types';
import type { PipelineConfig } from '../database/schema';

/**
 * CRM port. The domain layer only talks to this interface; Twenty specifics
 * (REST shapes, custom field names, stage option values) live behind it so the
 * CRM can be upgraded or replaced independently (Section 2).
 */
export const CRM_ADAPTER = 'CRM_ADAPTER';

export type CrmEntity = 'person' | 'company' | 'opportunity' | 'note' | 'task';
export type TaskKind = 'follow_up' | 'meeting' | 'call' | 'task';
export type TaskStatus = 'open' | 'done' | 'cancelled';

export interface CrmBase {
  id: string;
  archived: boolean;
  /** Twenty updatedAt — used as the optimistic record version (ACT-03) */
  updatedAt: string;
  createdAt?: string;
  ownerMemberId?: string;
  teamId?: string;
}

export interface CrmPerson extends CrmBase {
  firstName: string;
  lastName: string;
  name: string;
  email?: string;
  phone?: string;
  phoneRaw?: string;
  title?: string;
  companyId?: string;
}

export interface CrmCompany extends CrmBase {
  name: string;
  domain?: string;
  website?: string;
  address?: string;
  country?: string;
}

export interface CrmOpportunity extends CrmBase {
  title: string;
  stageId: string;
  amountMicros?: number;
  currency?: string;
  closeDate?: string;
  personId?: string;
  companyId?: string;
  interest?: string;
  source?: string;
  lostReason?: string;
}

export interface CrmNote extends CrmBase {
  title: string;
  text: string;
  noteType?: string;
  eventTime?: string;
  channel?: string;
}

export interface CrmTask extends CrmBase {
  title: string;
  status: TaskStatus;
  kind: TaskKind;
  /** UTC instant; for date-only tasks this is the start of the local day */
  dueAt?: string;
  /** Local YYYY-MM-DD in `timezone` */
  dueDate?: string;
  /** False for date-only follow-ups: never display an invented time (REM-02) */
  hasTime: boolean;
  timezone?: string;
  durationMin?: number;
  location?: string;
  completedAt?: string;
  assigneeMemberId?: string;
  personId?: string;
  companyId?: string;
  opportunityId?: string;
}

export interface Paged<T> {
  items: T[];
  /** True when more records existed than we were allowed to fetch (SUM-03 disclosure) */
  truncated: boolean;
  total?: number;
}

// ── Queries ────────────────────────────────────────────────────

/** Server-side scope pushed down as a filter; callers also post-filter (defense in depth). */
export interface ScopeFilter {
  /** 'all' = tenant-wide */
  kind: 'all' | 'owned' | 'team';
  ownerKey?: string;
  teamIds?: string[];
}

export interface PersonQuery {
  scope: ScopeFilter;
  email?: string;
  phoneE164?: string;
  /** Digits-only form for numbers that could not be normalized */
  phoneDigits?: string;
  nameContains?: string;
  companyId?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface CompanyQuery {
  scope: ScopeFilter;
  nameContains?: string;
  domain?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface OpportunityQuery {
  scope: ScopeFilter;
  personId?: string;
  companyId?: string;
  stageIds?: string[];
  archived?: boolean;
  titleContains?: string;
  updatedSince?: string;
  maxRecords?: number;
}

export interface TaskQuery {
  scope: ScopeFilter;
  status?: TaskStatus;
  assigneeKey?: string;
  dueBefore?: string;
  dueFrom?: string;
  opportunityId?: string;
  personId?: string;
  kind?: TaskKind;
  updatedSince?: string;
  includeArchived?: boolean;
  maxRecords?: number;
}

// ── Write inputs ───────────────────────────────────────────────

export interface Provenance {
  ownerKey?: string;
  teamId?: string;
  channel?: string;
  sourceEventIds?: string[];
}

export interface PersonInput extends Provenance {
  firstName: string;
  lastName?: string;
  email?: string;
  phoneE164?: string;
  phoneRaw?: string;
  title?: string;
  companyId?: string;
}
export interface CompanyInput extends Provenance {
  name: string;
  website?: string;
  domain?: string;
  address?: string;
  country?: string;
}
export interface OpportunityInput extends Provenance {
  title: string;
  stageId: string;
  personId?: string;
  companyId?: string;
  amountMicros?: number;
  currency?: string;
  closeDate?: string;
  interest?: string;
  source?: string;
}
export interface NoteInput extends Provenance {
  title: string;
  text: string;
  noteType?: string;
  eventTime?: string;
  authorKey?: string;
  targets: { personId?: string; companyId?: string; opportunityId?: string };
  attachmentRefs?: string[];
}
export interface TaskInput extends Provenance {
  title: string;
  kind: TaskKind;
  dueDate?: string;
  dueAt?: string;
  hasTime: boolean;
  timezone?: string;
  durationMin?: number;
  location?: string;
  assigneeKey?: string;
  targets: { personId?: string; companyId?: string; opportunityId?: string };
}

export interface PersonPatch { firstName?: string; lastName?: string; email?: string; phoneE164?: string; phoneRaw?: string; title?: string; companyId?: string; ownerKey?: string; teamId?: string }
export interface OpportunityPatch { stageId?: string; ownerKey?: string; teamId?: string; amountMicros?: number; currency?: string; closeDate?: string; lostReason?: string; title?: string }
export interface TaskPatch { dueAt?: string; dueDate?: string; hasTime?: boolean; timezone?: string; status?: TaskStatus; completedAt?: string | null; assigneeKey?: string; teamId?: string; title?: string }

export interface IntakeReviewInput {
  recordId: string;
  sourceId: string;
  reason: string;
  fields: Record<string, unknown>;
  operationRef: string;
  receivedAt: string;
}
export interface IntakeReviewItem {
  id: string;
  recordId: string;
  status: 'pending' | 'approved' | 'rejected';
  fields: Record<string, unknown>;
  reviewedBy?: string;
}

export interface SchemaReport {
  created: string[];
  existing: string[];
  warnings: string[];
}

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string | null;
  /** Twenty user id (global across workspaces) */
  userId: string | null;
}

export interface CrmAdapter {
  ensureSchema(ctx: TenantContext, pipeline: PipelineConfig): Promise<SchemaReport>;

  /** Members of the tenant's Twenty workspace (for linking employees to their Twenty login). */
  listWorkspaceMembers(ctx: TenantContext): Promise<WorkspaceMember[]>;

  findPeople(ctx: TenantContext, q: PersonQuery): Promise<CrmPerson[]>;
  findCompanies(ctx: TenantContext, q: CompanyQuery): Promise<CrmCompany[]>;
  getPerson(ctx: TenantContext, id: string): Promise<CrmPerson | null>;
  getCompany(ctx: TenantContext, id: string): Promise<CrmCompany | null>;
  getOpportunity(ctx: TenantContext, id: string): Promise<CrmOpportunity | null>;
  getTask(ctx: TenantContext, id: string): Promise<CrmTask | null>;
  /** Batched lookups (one request per 60 ids) for digests and summaries. */
  getPeopleByIds(ctx: TenantContext, ids: string[]): Promise<CrmPerson[]>;
  getCompaniesByIds(ctx: TenantContext, ids: string[]): Promise<CrmCompany[]>;
  getOpportunitiesByIds(ctx: TenantContext, ids: string[]): Promise<CrmOpportunity[]>;
  listOpportunities(ctx: TenantContext, q: OpportunityQuery): Promise<Paged<CrmOpportunity>>;
  listTasks(ctx: TenantContext, q: TaskQuery): Promise<Paged<CrmTask>>;
  listNotes(ctx: TenantContext, target: { personId?: string; companyId?: string; opportunityId?: string }, scope: ScopeFilter, limit?: number): Promise<CrmNote[]>;

  /** Recover a record created by an earlier attempt whose response was lost (ACT-05, AT-13). */
  findByOperationKey(ctx: TenantContext, entity: CrmEntity, operationKey: string): Promise<{ id: string } | null>;

  createPerson(ctx: TenantContext, input: PersonInput, operationKey: string): Promise<CrmPerson>;
  createCompany(ctx: TenantContext, input: CompanyInput, operationKey: string): Promise<CrmCompany>;
  createOpportunity(ctx: TenantContext, input: OpportunityInput, operationKey: string): Promise<CrmOpportunity>;
  createNote(ctx: TenantContext, input: NoteInput, operationKey: string): Promise<CrmNote>;
  createTask(ctx: TenantContext, input: TaskInput, operationKey: string): Promise<CrmTask>;

  updatePerson(ctx: TenantContext, id: string, patch: PersonPatch): Promise<CrmPerson>;
  updateOpportunity(ctx: TenantContext, id: string, patch: OpportunityPatch): Promise<CrmOpportunity>;
  updateTask(ctx: TenantContext, id: string, patch: TaskPatch): Promise<CrmTask>;
  /** Recoverable archive/restore via the `beeArchived` field — never a hard delete. */
  setArchived(ctx: TenantContext, entity: 'person' | 'company' | 'opportunity' | 'task', id: string, archived: boolean): Promise<void>;
  /** Re-point linked tasks/notes ownership when assignments change. */
  assignOwner(ctx: TenantContext, entity: 'person' | 'company' | 'opportunity' | 'task', id: string, ownerKey: string, teamId?: string): Promise<void>;

  upsertIntakeReview(ctx: TenantContext, input: IntakeReviewInput): Promise<{ id: string }>;
  listIntakeReviews(ctx: TenantContext, status: 'approved' | 'pending' | 'rejected'): Promise<IntakeReviewItem[]>;
  setIntakeReviewStatus(ctx: TenantContext, id: string, status: 'approved' | 'rejected' | 'pending', reviewedBy?: string): Promise<void>;

  /** Authorized deep link into the Twenty UI (CAP-08). */
  recordUrl(ctx: TenantContext, entity: Exclude<CrmEntity, 'note'>, id: string): string;
}

/** Errors the adapter raises; the queue/worker layer maps them to retry/permanent. */
export class CrmPermanentError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'CrmPermanentError';
  }
}
export class CrmTransientError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'CrmTransientError';
  }
}

/**
 * Stable ownership key written to beeOwnerMemberId / beeTeamId and used by every scope filter. It is the Bee user id
 * and never changes — linking or re-linking a Twenty member must not hide a salesperson's existing records from them.
 * Twenty's native owner fields (owner / accountOwner / assignee) are set separately for the web UI.
 */
export const ownerKeyOf = (u: { userId: string }): string => u.userId;
