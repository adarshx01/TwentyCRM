import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import type { TenantContext } from '../../common/types';
import type { PipelineConfig } from '../../database/schema';
import {
  CrmPermanentError,
  type CompanyInput, type CompanyQuery, type CrmAdapter, type CrmCompany, type CrmEntity, type CrmNote,
  type CrmOpportunity, type CrmPerson, type CrmTask, type IntakeReviewInput, type IntakeReviewItem,
  type NoteInput, type OpportunityInput, type OpportunityPatch, type OpportunityQuery, type Paged, type PersonInput,
  type PersonPatch, type PersonQuery, type SchemaReport, type ScopeFilter, type TaskInput, type TaskPatch, type TaskQuery,
} from '../crm-adapter.interface';
import { TwentyClient, firstDataValue } from './twenty-client';
import { INTAKE_REVIEW_OBJECT, REQUIRED_FIELDS, stageOptions, stageToOption } from './twenty.schema';

const PATHS = {
  person: '/rest/people',
  company: '/rest/companies',
  opportunity: '/rest/opportunities',
  note: '/rest/notes',
  task: '/rest/tasks',
} as const;
const UI_SEGMENT = { person: 'person', company: 'company', opportunity: 'opportunity', task: 'task' } as const;

// ── filter helpers (values are sanitized: no quotes/parens/control chars) ──
// eslint-disable-next-line no-control-regex -- control characters are stripped on purpose (filter-injection guard)
export const clean = (v: string): string => v.replace(/[\\"()\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
const eq = (f: string, v: string | number | boolean) => `${f}[eq]:${typeof v === 'string' ? `"${clean(v)}"` : v}`;
const ilike = (f: string, v: string) => `${f}[ilike]:"%${clean(v)}%"`;
const ilikeExact = (f: string, v: string) => `${f}[ilike]:"${clean(v)}"`;
const gte = (f: string, v: string) => `${f}[gte]:"${clean(v)}"`;
const lte = (f: string, v: string) => `${f}[lte]:"${clean(v)}"`;
const inList = (f: string, vs: string[]) => `${f}[in]:[${vs.map((v) => `"${clean(v)}"`).join(',')}]`;
const or = (parts: string[]) => (parts.length === 1 ? parts[0] : `or(${parts.join(',')})`);
const and = (parts: string[]) => (parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : `and(${parts.join(',')})`);

function scopeParts(scope: ScopeFilter): string[] {
  if (scope.kind === 'all') return [];
  if (!scope.ownerKey) return [eq('beeOwnerMemberId', '__none__')]; // fail closed
  if (scope.kind === 'owned') return [eq('beeOwnerMemberId', scope.ownerKey)];
  const parts = [eq('beeOwnerMemberId', scope.ownerKey)];
  if (scope.teamIds?.length) parts.push(inList('beeTeamId', scope.teamIds));
  return [or(parts)];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);

/**
 * Twenty implementation of the CRM port. Field mapping is documented in
 * docs/twenty-mapping.md and must be re-verified against the pinned release (G2/G3).
 *
 * Idempotency: every create first looks up `beeOperationKey`; after a timeout the
 * caller retries and finds the earlier record instead of creating a second one.
 */
@Injectable()
export class TwentyAdapter implements CrmAdapter {
  constructor(
    private readonly client: TwentyClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── mapping ──────────────────────────────────────────────────
  private base(raw: any) {
    return {
      id: raw.id as string,
      archived: raw.beeArchived === true,
      updatedAt: (raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString()) as string,
      createdAt: raw.createdAt as string | undefined,
      ownerMemberId: str(raw.beeOwnerMemberId),
      teamId: str(raw.beeTeamId),
    };
  }

  private toPerson(raw: any): CrmPerson {
    const firstName = raw.name?.firstName ?? '';
    const lastName = raw.name?.lastName ?? '';
    return {
      ...this.base(raw), firstName, lastName, name: `${firstName} ${lastName}`.trim(),
      email: str(raw.emails?.primaryEmail), phone: str(raw.beePhoneE164), phoneRaw: str(raw.beePhoneRaw),
      title: str(raw.jobTitle), companyId: str(raw.companyId),
    };
  }

  private toCompany(raw: any): CrmCompany {
    return { ...this.base(raw), name: raw.name ?? '', domain: str(raw.domainName?.primaryLinkUrl), website: str(raw.domainName?.primaryLinkUrl), address: str(raw.address?.addressStreet1), country: str(raw.address?.addressCountry) };
  }

  private toOpportunity(raw: any, pipeline?: PipelineConfig): CrmOpportunity {
    const option: string = raw.stage ?? '';
    const stage = pipeline?.stages.find((s) => stageToOption(s.id) === option);
    return {
      ...this.base(raw), title: raw.name ?? '', stageId: stage?.id ?? option.toLowerCase(),
      amountMicros: raw.amount?.amountMicros != null ? Number(raw.amount.amountMicros) : undefined,
      currency: str(raw.amount?.currencyCode), closeDate: str(raw.closeDate), personId: str(raw.pointOfContactId), companyId: str(raw.companyId),
      interest: str(raw.beeInterest), source: str(raw.beeSource), lostReason: str(raw.beeLostReason),
    };
  }

  private toNote(raw: any): CrmNote {
    return { ...this.base(raw), title: raw.title ?? '', text: raw.bodyV2?.markdown ?? '', noteType: str(raw.beeNoteType), eventTime: str(raw.beeEventTime), channel: str(raw.beeChannel) };
  }

  private toTask(raw: any): CrmTask {
    const status = raw.beeStatus === 'cancelled' ? 'cancelled' : raw.beeStatus === 'done' || raw.status === 'DONE' ? 'done' : 'open';
    return {
      ...this.base(raw), title: raw.title ?? '', status, kind: (raw.beeTaskKind as CrmTask['kind']) ?? 'task',
      dueAt: str(raw.dueAt), dueDate: str(raw.beeDueDate), hasTime: raw.beeHasTime === true, timezone: str(raw.beeTimezone),
      durationMin: raw.beeDurationMin != null ? Number(raw.beeDurationMin) : undefined, location: str(raw.beeLocation),
      completedAt: str(raw.beeCompletedAt), assigneeMemberId: str(raw.beeOwnerMemberId), personId: str(raw.beePersonId),
      companyId: str(raw.beeCompanyId), opportunityId: str(raw.beeOpportunityId),
    };
  }

  private provenance(p: { ownerKey?: string; teamId?: string; channel?: string; sourceEventIds?: string[] }, key?: string) {
    return {
      ...(key ? { beeOperationKey: key } : {}),
      beeOwnerMemberId: p.ownerKey ?? null,
      beeTeamId: p.teamId ?? null,
      beeArchived: false,
      beeSource: p.channel ?? null,
      beeSourceEventIds: p.sourceEventIds?.join(',') ?? null,
    };
  }

  // ── schema provisioning (CFG-02, CFG-04) ─────────────────────
  async ensureSchema(ctx: TenantContext, pipeline: PipelineConfig): Promise<SchemaReport> {
    const report: SchemaReport = { created: [], existing: [], warnings: [] };
    const res = await this.client.request(ctx, { method: 'GET', path: '/rest/metadata/objects' });
    // Real Twenty returns { data: [objects…] }; older/fake shape is { data: { objects: [...] } }.
    const listed: unknown = Array.isArray((res as any)?.data) ? (res as any).data : firstDataValue(res);
    let objects: any[] = Array.isArray(listed) ? listed : [];
    const find = (singular: string) => objects.find((o) => o.nameSingular === singular);

    const ensureFields = async (objectId: string, existingFields: any[], specs: Array<{ name: string; label: string; type: string; defaultValue?: unknown }>, objName: string) => {
      for (const f of specs) {
        if (existingFields.some((e) => e.name === f.name)) { report.existing.push(`${objName}.${f.name}`); continue; }
        await this.client.request(ctx, { method: 'POST', path: '/rest/metadata/fields', body: { objectMetadataId: objectId, name: f.name, label: f.label, type: f.type, defaultValue: typeof f.defaultValue === 'string' ? `'${f.defaultValue}'` : (f.defaultValue ?? undefined) } });
        report.created.push(`${objName}.${f.name}`);
      }
    };

    for (const [objName, specs] of Object.entries(REQUIRED_FIELDS)) {
      const obj = find(objName);
      if (!obj) { report.warnings.push(`object ${objName} missing in workspace`); continue; }
      await ensureFields(obj.id, obj.fields ?? [], specs, objName);
    }

    // Pipeline stages → SELECT options on opportunity.stage. Existing options are never dropped here:
    // removing a stage with active records needs a previewed migration (CFG-04).
    const opp = find('opportunity');
    const stageField = opp?.fields?.find((f: any) => f.name === 'stage');
    if (stageField) {
      const desired = stageOptions(pipeline);
      const have = new Set<string>((stageField.options ?? []).map((o: any) => o.value));
      const merged = [...(stageField.options ?? []).map((o: any) => {
        const d = desired.find((x) => x.value === o.value);
        return d ? { ...o, label: d.label } : o;
      })];
      let changed = merged.some((o: any, i: number) => o.label !== stageField.options[i]?.label);
      for (const d of desired) if (!have.has(d.value)) { merged.push(d); changed = true; }
      if (changed) {
        await this.client.request(ctx, { method: 'PATCH', path: `/rest/metadata/fields/${stageField.id}`, body: { options: merged.map(({ value, label, position, color }: any, i: number) => ({ value, label, color, position: i })) } });
        report.created.push('opportunity.stage.options');
      } else report.existing.push('opportunity.stage.options');
      const extra = (stageField.options ?? []).filter((o: any) => !desired.some((d) => d.value === o.value));
      if (extra.length) report.warnings.push(`stage options not in manifest (kept): ${extra.map((o: any) => o.value).join(', ')}`);
    } else report.warnings.push('opportunity.stage field not found');

    let review = find(INTAKE_REVIEW_OBJECT.nameSingular);
    if (!review) {
      const created = await this.client.request(ctx, { method: 'POST', path: '/rest/metadata/objects', body: { nameSingular: INTAKE_REVIEW_OBJECT.nameSingular, namePlural: INTAKE_REVIEW_OBJECT.namePlural, labelSingular: INTAKE_REVIEW_OBJECT.labelSingular, labelPlural: INTAKE_REVIEW_OBJECT.labelPlural } });
      const c: any = created;
      review = c?.id ? c : (c?.data?.id ? c.data : firstDataValue(created)) as any;
      report.created.push('object intakeReview');
      objects = [...objects, review];
    } else report.existing.push('object intakeReview');
    await ensureFields(review.id, review.fields ?? [], INTAKE_REVIEW_OBJECT.fields, 'intakeReview');
    return report;
  }

  // ── reads ────────────────────────────────────────────────────
  async findPeople(ctx: TenantContext, q: PersonQuery): Promise<CrmPerson[]> {
    const parts = [...scopeParts(q.scope)];
    const ors: string[] = [];
    if (q.email) ors.push(ilikeExact('emails.primaryEmail', q.email));
    if (q.phoneE164) ors.push(eq('beePhoneE164', q.phoneE164));
    if (q.phoneDigits) ors.push(eq('beePhoneDigits', q.phoneDigits));
    if (ors.length) parts.push(or(ors));
    if (q.nameContains) {
      for (const token of clean(q.nameContains).split(' ').slice(0, 4)) {
        if (token.length < 2) continue;
        parts.push(or([ilike('name.firstName', token), ilike('name.lastName', token)]));
      }
    }
    if (q.companyId) parts.push(eq('companyId', q.companyId));
    if (q.includeArchived === false || q.includeArchived === undefined) { /* post-filter below */ }
    const { records } = await this.client.listAll(ctx, PATHS.person, and(parts), { max: q.limit ?? 50, pageSize: Math.min(q.limit ?? 50, 60) });
    return records.map((r) => this.toPerson(r)).filter((p) => q.includeArchived || !p.archived);
  }

  async findCompanies(ctx: TenantContext, q: CompanyQuery): Promise<CrmCompany[]> {
    const parts = [...scopeParts(q.scope)];
    if (q.nameContains) parts.push(ilike('name', q.nameContains));
    if (q.domain) parts.push(ilike('domainName.primaryLinkUrl', q.domain));
    const { records } = await this.client.listAll(ctx, PATHS.company, and(parts), { max: q.limit ?? 50, pageSize: Math.min(q.limit ?? 50, 60) });
    return records.map((r) => this.toCompany(r)).filter((c) => q.includeArchived || !c.archived);
  }

  private async getRaw(ctx: TenantContext, entity: keyof typeof PATHS, id: string): Promise<any | null> {
    try {
      const res = await this.client.request(ctx, { method: 'GET', path: `${PATHS[entity]}/${encodeURIComponent(id)}` });
      return firstDataValue(res) ?? null;
    } catch (e) {
      if (e instanceof CrmPermanentError && e.status === 404) return null;
      throw e;
    }
  }

  async getPerson(ctx: TenantContext, id: string) { const r = await this.getRaw(ctx, 'person', id); return r ? this.toPerson(r) : null; }
  async getCompany(ctx: TenantContext, id: string) { const r = await this.getRaw(ctx, 'company', id); return r ? this.toCompany(r) : null; }
  async getOpportunity(ctx: TenantContext, id: string) { const r = await this.getRaw(ctx, 'opportunity', id); return r ? this.toOpportunity(r, ctx.pipeline) : null; }
  async getTask(ctx: TenantContext, id: string) { const r = await this.getRaw(ctx, 'task', id); return r ? this.toTask(r) : null; }

  private async byIds(ctx: TenantContext, path: string, ids: string[]): Promise<any[]> {
    const unique = [...new Set(ids)].filter(Boolean);
    const out: any[] = [];
    for (let i = 0; i < unique.length; i += 60) {
      const { records } = await this.client.listAll(ctx, path, inList('id', unique.slice(i, i + 60)), { max: 60 });
      out.push(...records);
    }
    return out;
  }
  async getPeopleByIds(ctx: TenantContext, ids: string[]) { return (await this.byIds(ctx, PATHS.person, ids)).map((r) => this.toPerson(r)); }
  async getCompaniesByIds(ctx: TenantContext, ids: string[]) { return (await this.byIds(ctx, PATHS.company, ids)).map((r) => this.toCompany(r)); }
  async getOpportunitiesByIds(ctx: TenantContext, ids: string[]) { return (await this.byIds(ctx, PATHS.opportunity, ids)).map((r) => this.toOpportunity(r, ctx.pipeline)); }

  async listOpportunities(ctx: TenantContext, q: OpportunityQuery): Promise<Paged<CrmOpportunity>> {
    const parts = [...scopeParts(q.scope)];
    if (q.personId) parts.push(eq('pointOfContactId', q.personId));
    if (q.companyId) parts.push(eq('companyId', q.companyId));
    if (q.stageIds?.length) parts.push(inList('stage', q.stageIds.map(stageToOption)));
    if (q.archived === true) parts.push(eq('beeArchived', true));
    if (q.titleContains) parts.push(ilike('name', q.titleContains));
    if (q.updatedSince) parts.push(gte('updatedAt', q.updatedSince));
    const { records, truncated, total } = await this.client.listAll(ctx, PATHS.opportunity, and(parts), { max: q.maxRecords ?? 10_000 });
    const items = records.map((r) => this.toOpportunity(r, ctx.pipeline)).filter((o) => (q.archived === undefined ? !o.archived : q.archived ? o.archived : !o.archived));
    return { items, truncated, total };
  }

  async listTasks(ctx: TenantContext, q: TaskQuery): Promise<Paged<CrmTask>> {
    const parts = [...scopeParts(q.scope)];
    if (q.assigneeKey) parts.push(eq('beeOwnerMemberId', q.assigneeKey));
    if (q.opportunityId) parts.push(eq('beeOpportunityId', q.opportunityId));
    if (q.personId) parts.push(eq('beePersonId', q.personId));
    if (q.kind) parts.push(eq('beeTaskKind', q.kind));
    if (q.dueBefore) parts.push(lte('dueAt', q.dueBefore));
    if (q.dueFrom) parts.push(gte('dueAt', q.dueFrom));
    if (q.updatedSince) parts.push(gte('updatedAt', q.updatedSince));
    const { records, truncated, total } = await this.client.listAll(ctx, PATHS.task, and(parts), { max: q.maxRecords ?? 10_000 });
    const items = records.map((r) => this.toTask(r)).filter((t) => (q.includeArchived || !t.archived) && (!q.status || t.status === q.status));
    return { items, truncated, total };
  }

  async listNotes(ctx: TenantContext, target: { personId?: string; companyId?: string; opportunityId?: string }, scope: ScopeFilter, limit = 5): Promise<CrmNote[]> {
    const field = target.opportunityId ? 'opportunityId' : target.companyId ? 'companyId' : 'personId';
    const id = target.opportunityId ?? target.companyId ?? target.personId;
    if (!id) return [];
    const links = await this.client.listAll(ctx, '/rest/noteTargets', eq(field, id), { max: 200 });
    const noteIds = [...new Set(links.records.map((l) => l.noteId as string))];
    const notes: CrmNote[] = [];
    for (const nid of noteIds.slice(0, 50)) {
      const raw = await this.getRaw(ctx, 'note', nid);
      if (!raw) continue;
      const n = this.toNote(raw);
      if (n.archived) continue;
      // A relation must not expose another salesperson's notes (Section 4).
      if (scope.kind === 'owned' && n.ownerMemberId !== scope.ownerKey) continue;
      if (scope.kind === 'team' && n.ownerMemberId !== scope.ownerKey && !(n.teamId && scope.teamIds?.includes(n.teamId))) continue;
      notes.push(n);
    }
    return notes.sort((a, b) => (b.eventTime ?? b.createdAt ?? '').localeCompare(a.eventTime ?? a.createdAt ?? '')).slice(0, limit);
  }

  async findByOperationKey(ctx: TenantContext, entity: CrmEntity, operationKey: string): Promise<{ id: string } | null> {
    const res = await this.client.request(ctx, { method: 'GET', path: PATHS[entity], query: { filter: eq('beeOperationKey', operationKey), limit: 1 } });
    const rows = (firstDataValue(res) as any[]) ?? [];
    return rows[0] ? { id: rows[0].id } : null;
  }

  // ── writes ───────────────────────────────────────────────────
  private async createOnce(ctx: TenantContext, entity: keyof typeof PATHS, key: string, body: Record<string, unknown>): Promise<any> {
    const existing = await this.findByOperationKey(ctx, entity, key);
    if (existing) {
      const raw = await this.getRaw(ctx, entity, existing.id);
      if (raw) return raw;
    }
    const res = await this.client.request(ctx, { method: 'POST', path: PATHS[entity], body: { ...body, beeOperationKey: key } });
    return firstDataValue(res);
  }

  async createPerson(ctx: TenantContext, input: PersonInput, operationKey: string): Promise<CrmPerson> {
    const digits = input.phoneRaw?.replace(/\D/g, '');
    const raw = await this.createOnce(ctx, 'person', operationKey, {
      name: { firstName: input.firstName, lastName: input.lastName ?? '' },
      ...(input.email ? { emails: { primaryEmail: input.email } } : {}),
      ...(input.title ? { jobTitle: input.title } : {}),
      ...(input.companyId ? { companyId: input.companyId } : {}),
      beePhoneE164: input.phoneE164 ?? null, beePhoneRaw: input.phoneRaw ?? null, beePhoneDigits: digits ?? null,
      ...(input.phoneE164 ? { phones: { primaryPhoneNumber: input.phoneE164 } } : input.phoneRaw ? { phones: { primaryPhoneNumber: input.phoneRaw } } : {}),
      ...this.provenance(input),
    });
    return this.toPerson(raw);
  }

  async createCompany(ctx: TenantContext, input: CompanyInput, operationKey: string): Promise<CrmCompany> {
    const raw = await this.createOnce(ctx, 'company', operationKey, {
      name: input.name,
      ...(input.website || input.domain ? { domainName: { primaryLinkUrl: input.website ?? input.domain } } : {}),
      ...(input.address || input.country ? { address: { addressStreet1: input.address ?? '', addressCountry: input.country ?? '' } } : {}),
      ...this.provenance(input),
    });
    return this.toCompany(raw);
  }

  async createOpportunity(ctx: TenantContext, input: OpportunityInput, operationKey: string): Promise<CrmOpportunity> {
    const raw = await this.createOnce(ctx, 'opportunity', operationKey, {
      name: input.title, stage: stageToOption(input.stageId),
      ...(input.personId ? { pointOfContactId: input.personId } : {}),
      ...(input.companyId ? { companyId: input.companyId } : {}),
      ...(input.amountMicros != null ? { amount: { amountMicros: input.amountMicros, currencyCode: input.currency ?? ctx.defaultCurrency } } : {}),
      ...(input.closeDate ? { closeDate: input.closeDate } : {}),
      beeInterest: input.interest ?? null,
      ...this.provenance(input),
    });
    return this.toOpportunity(raw, ctx.pipeline);
  }

  private async ensureTargets(ctx: TenantContext, path: '/rest/noteTargets' | '/rest/taskTargets', ownerField: 'noteId' | 'taskId', ownerId: string, targets: { personId?: string; companyId?: string; opportunityId?: string }): Promise<void> {
    const existing = await this.client.listAll(ctx, path, eq(ownerField, ownerId), { max: 50 });
    for (const [field, id] of Object.entries(targets)) {
      if (!id) continue;
      if (existing.records.some((r) => r[field] === id)) continue;
      await this.client.request(ctx, { method: 'POST', path, body: { [ownerField]: ownerId, [field]: id } });
    }
  }

  async createNote(ctx: TenantContext, input: NoteInput, operationKey: string): Promise<CrmNote> {
    const raw = await this.createOnce(ctx, 'note', operationKey, {
      title: input.title, bodyV2: { markdown: input.text },
      beeNoteType: input.noteType ?? 'observation', beeEventTime: input.eventTime ?? null, beeChannel: input.channel ?? null,
      beeAttachmentRefs: input.attachmentRefs?.join(',') ?? null,
      ...this.provenance({ ...input, ownerKey: input.authorKey ?? input.ownerKey }),
    });
    await this.ensureTargets(ctx, '/rest/noteTargets', 'noteId', raw.id, input.targets);
    return this.toNote(raw);
  }

  async createTask(ctx: TenantContext, input: TaskInput, operationKey: string): Promise<CrmTask> {
    const dueAt = input.dueAt ?? (input.dueDate ? DateTime.fromISO(input.dueDate, { zone: input.timezone ?? ctx.timezone }).startOf('day').toUTC().toISO() : undefined);
    const raw = await this.createOnce(ctx, 'task', operationKey, {
      title: input.title, status: 'TODO', ...(dueAt ? { dueAt } : {}),
      beeTaskKind: input.kind, beeStatus: 'open', beeDueDate: input.dueDate ?? null, beeHasTime: input.hasTime,
      beeTimezone: input.timezone ?? ctx.timezone, beeDurationMin: input.durationMin ?? null, beeLocation: input.location ?? null,
      beePersonId: input.targets.personId ?? null, beeCompanyId: input.targets.companyId ?? null, beeOpportunityId: input.targets.opportunityId ?? null,
      ...this.provenance({ ...input, ownerKey: input.assigneeKey ?? input.ownerKey }),
    });
    await this.ensureTargets(ctx, '/rest/taskTargets', 'taskId', raw.id, input.targets);
    return this.toTask(raw);
  }

  private async patch(ctx: TenantContext, entity: keyof typeof PATHS, id: string, body: Record<string, unknown>): Promise<any> {
    const res = await this.client.request(ctx, { method: 'PATCH', path: `${PATHS[entity]}/${encodeURIComponent(id)}`, body });
    return firstDataValue(res);
  }

  async updatePerson(ctx: TenantContext, id: string, p: PersonPatch): Promise<CrmPerson> {
    const body: Record<string, unknown> = {};
    if (p.firstName !== undefined || p.lastName !== undefined) body.name = { firstName: p.firstName ?? '', lastName: p.lastName ?? '' };
    if (p.email) body.emails = { primaryEmail: p.email };
    if (p.title) body.jobTitle = p.title;
    if (p.companyId) body.companyId = p.companyId;
    if (p.phoneE164 || p.phoneRaw) {
      body.beePhoneE164 = p.phoneE164 ?? null; body.beePhoneRaw = p.phoneRaw ?? null; body.beePhoneDigits = p.phoneRaw?.replace(/\D/g, '') ?? null;
      body.phones = { primaryPhoneNumber: p.phoneE164 ?? p.phoneRaw };
    }
    if (p.ownerKey) body.beeOwnerMemberId = p.ownerKey;
    if (p.teamId !== undefined) body.beeTeamId = p.teamId;
    return this.toPerson(await this.patch(ctx, 'person', id, body));
  }

  async updateOpportunity(ctx: TenantContext, id: string, p: OpportunityPatch): Promise<CrmOpportunity> {
    const body: Record<string, unknown> = {};
    if (p.stageId) body.stage = stageToOption(p.stageId);
    if (p.ownerKey) body.beeOwnerMemberId = p.ownerKey;
    if (p.teamId !== undefined) body.beeTeamId = p.teamId;
    if (p.title) body.name = p.title;
    if (p.amountMicros != null) body.amount = { amountMicros: p.amountMicros, currencyCode: p.currency ?? ctx.defaultCurrency };
    if (p.closeDate) body.closeDate = p.closeDate;
    if (p.lostReason) body.beeLostReason = p.lostReason;
    return this.toOpportunity(await this.patch(ctx, 'opportunity', id, body), ctx.pipeline);
  }

  async updateTask(ctx: TenantContext, id: string, p: TaskPatch): Promise<CrmTask> {
    const body: Record<string, unknown> = {};
    if (p.dueAt !== undefined) body.dueAt = p.dueAt;
    if (p.dueDate !== undefined) body.beeDueDate = p.dueDate;
    if (p.hasTime !== undefined) body.beeHasTime = p.hasTime;
    if (p.timezone) body.beeTimezone = p.timezone;
    if (p.title) body.title = p.title;
    if (p.status) { body.beeStatus = p.status; body.status = p.status === 'open' ? 'TODO' : 'DONE'; }
    if (p.completedAt !== undefined) body.beeCompletedAt = p.completedAt;
    if (p.assigneeKey) body.beeOwnerMemberId = p.assigneeKey;
    if (p.teamId !== undefined) body.beeTeamId = p.teamId;
    return this.toTask(await this.patch(ctx, 'task', id, body));
  }

  async setArchived(ctx: TenantContext, entity: 'person' | 'company' | 'opportunity' | 'task', id: string, archived: boolean): Promise<void> {
    await this.patch(ctx, entity, id, { beeArchived: archived });
  }

  async assignOwner(ctx: TenantContext, entity: 'person' | 'company' | 'opportunity' | 'task', id: string, ownerKey: string, teamId?: string): Promise<void> {
    await this.patch(ctx, entity, id, { beeOwnerMemberId: ownerKey, ...(teamId !== undefined ? { beeTeamId: teamId } : {}) });
  }

  // ── intake review (IN-11) ────────────────────────────────────
  async upsertIntakeReview(ctx: TenantContext, input: IntakeReviewInput): Promise<{ id: string }> {
    const existing = await this.client.request(ctx, { method: 'GET', path: '/rest/intakeReviews', query: { filter: eq('beeRecordId', input.recordId), limit: 1 } });
    const row = ((firstDataValue(existing) as any[]) ?? [])[0];
    if (row) return { id: row.id };
    const res = await this.client.request(ctx, {
      method: 'POST', path: '/rest/intakeReviews',
      body: { name: `Enquiry review ${input.recordId.slice(0, 8)}`, beeRecordId: input.recordId, beeSourceId: input.sourceId, beeStatus: 'pending', beeReason: input.reason, beeFields: JSON.stringify(input.fields), beeOperationRef: input.operationRef, beeReceivedAt: input.receivedAt },
    });
    return { id: (firstDataValue(res) as any).id };
  }

  async listIntakeReviews(ctx: TenantContext, status: 'approved' | 'pending' | 'rejected'): Promise<IntakeReviewItem[]> {
    const { records } = await this.client.listAll(ctx, '/rest/intakeReviews', eq('beeStatus', status), { max: 500 });
    return records.map((r) => ({
      id: r.id, recordId: r.beeRecordId, status: r.beeStatus, reviewedBy: str(r.beeReviewedBy),
      fields: (() => { try { return JSON.parse(r.beeFields ?? '{}'); } catch { return {}; } })(),
    }));
  }

  async setIntakeReviewStatus(ctx: TenantContext, id: string, status: 'approved' | 'rejected' | 'pending', reviewedBy?: string): Promise<void> {
    await this.client.request(ctx, { method: 'PATCH', path: `/rest/intakeReviews/${encodeURIComponent(id)}`, body: { beeStatus: status, ...(reviewedBy ? { beeReviewedBy: reviewedBy } : {}) } });
  }

  recordUrl(ctx: TenantContext, entity: Exclude<CrmEntity, 'note'>, id: string): string {
    const base = (ctx.twentyBaseUrl ?? this.config.twenty.apiUrl).replace(/\/$/, '');
    return `${base}/object/${UI_SEGMENT[entity]}/${id}`;
  }
}
