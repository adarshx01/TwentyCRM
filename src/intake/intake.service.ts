import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, ne, or, sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DbService } from '../database/db.service';
import { intakeRecords, intakeSources, deadLetters, users, type IntakeTimestamps, type ProposedAction } from '../database/schema';
import { MediaService } from '../media/media.service';
import { QueueService } from '../queue/queue.service';
import { QUEUES, type CrmWriteJob, type EmailIntakeJob } from '../queue/queues';
import { OperationJournal, type OperationRow } from '../crm/operations/operation-journal.service';
import { CRM_ADAPTER, type CrmAdapter } from '../crm/crm-adapter.interface';
import { AssignmentService } from './assignment.service';
import { AuditService } from '../audit/audit.service';
import { TenantService } from '../tenant/tenant.service';
import { IdentityService } from '../identity/identity.service';
import { OutboundService } from '../outbound/outbound.service';
import { addWorkingDays } from '../common/utils/date.util';
import { can, recordScopeOf } from '../access/permissions';
import type { UserRole } from '../database/schema';
import { CaptureLeadActionSchema, type CaptureLeadAction } from '../common/schemas';
import { meetsAutoSaveMinimum, parseEmail, parseFormEvent, type ParsedEmail, type ParsedFields } from './intake-parser';
import { PermanentError, UserFacingError } from '../common/errors';
import { M } from '../observability/metrics';
import { getLogger } from '../observability/logger';

export type IntakeRow = typeof intakeRecords.$inferSelect;
type SourceRow = typeof intakeSources.$inferSelect;

export interface InboundEmailEnvelope {
  /** Provider event id (dedup) */
  eventId: string;
  /** The ACTUAL delivery recipient from the authenticated provider event — never a header (IN tenant routing) */
  recipient: string;
  /** Raw RFC822 message */
  raw: Buffer;
  receivedAt?: string;
  /** Authentication evidence the provider verified (SPF/DKIM/DMARC) */
  auth?: Record<string, unknown>;
}

/** Fingerprint copies (forwarding/retries) are suppressed only inside this window (IN-08). */
const FINGERPRINT_WINDOW_HOURS = 6;

interface Meta { templateMatched: boolean; senderAllowed: boolean; suspicious: string[]; missing: string[]; messageId?: string; from?: string; subject?: string }

/** Who reviews an intake item (IN-11). */
export interface ReviewActor { id: string; role: UserRole; managedTeamIds?: string[] }

/**
 * Contact-form email intake (Sections 16–18, IN-01..IN-12).
 * Trust model: tenant and source come only from the authenticated delivery recipient or the
 * registered mailbox — never from message content. Email text cannot authorize CRM actions;
 * it is parsed deterministically and anything uncertain goes to a human review queue.
 */
@Injectable()
export class IntakeService {
  private readonly log = getLogger('intake');

  constructor(
    private readonly db: DbService,
    private readonly media: MediaService,
    private readonly queue: QueueService,
    private readonly journal: OperationJournal,
    private readonly assignment: AssignmentService,
    private readonly audit: AuditService,
    private readonly tenants: TenantService,
    private readonly identity: IdentityService,
    private readonly outbound: OutboundService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
  ) {}

  // ── receive ─────────────────────────────────────────────────
  private async sourceByAlias(recipient: string): Promise<SourceRow | null> {
    const [src] = await this.db.systemTx((tx) => tx.select().from(intakeSources).where(and(eq(intakeSources.intakeAlias, recipient.trim().toLowerCase()), eq(intakeSources.status, 'active'))));
    return src ?? null;
  }

  private async quarantine(reason: string, detail: Record<string, unknown>): Promise<void> {
    M.intakeResults().inc({ result: 'quarantined' });
    await this.db.systemTx((tx) => tx.insert(deadLetters).values({ queue: 'intake-quarantine', payload: detail, error: reason }));
  }

  /** Authenticated inbound-email webhook → durable record + job. */
  async receiveEmail(env: InboundEmailEnvelope): Promise<{ status: 'accepted' | 'duplicate' | 'quarantined'; recordId?: string }> {
    const src = await this.sourceByAlias(env.recipient);
    if (!src) { await this.quarantine('unknown route', { eventId: env.eventId }); return { status: 'quarantined' }; }
    return this.persistReceived(src, `${src.tenantId}/${src.sourceId}/${env.eventId}`, { raw: env.raw, auth: env.auth, receivedAt: env.receivedAt });
  }

  /** Mailbox-poll route: the registered mailbox identifies the source (IN-02). */
  async receiveFromMailbox(src: SourceRow, messageKey: string, raw: Buffer, receivedAt?: string): Promise<{ status: 'accepted' | 'duplicate'; recordId?: string }> {
    const r = await this.persistReceived(src, `${src.tenantId}/${src.sourceId}/mbx:${messageKey}`, { raw, receivedAt });
    return r.status === 'duplicate' ? { status: 'duplicate' } : { status: 'accepted', recordId: r.recordId };
  }

  /** Signed direct form event (IN-03). */
  async receiveForm(src: SourceRow, body: { submissionId?: string; fields: Record<string, unknown>; submittedAt?: string }): Promise<{ status: 'accepted' | 'duplicate'; recordId?: string }> {
    const parsed = parseFormEvent(body, src.parsingRules);
    const key = `${src.tenantId}/${src.sourceId}/form:${body.submissionId ?? parsed.fingerprint}`;
    const r = await this.persistReceived(src, key, { parsed, receivedAt: body.submittedAt });
    return r.status === 'duplicate' ? { status: 'duplicate' } : { status: 'accepted', recordId: r.recordId };
  }

  private async persistReceived(src: SourceRow, deliveryKey: string, input: { raw?: Buffer; parsed?: ParsedEmail; auth?: Record<string, unknown>; receivedAt?: string }): Promise<{ status: 'accepted' | 'duplicate'; recordId?: string }> {
    const existing = await this.db.tenantTx(src.tenantId, async (tx) => (await tx.select({ id: intakeRecords.id }).from(intakeRecords).where(eq(intakeRecords.deliveryIdempotencyKey, deliveryKey)))[0]);
    if (existing) { M.duplicateSuppressed().inc({ kind: 'intake_delivery' }); return { status: 'duplicate', recordId: existing.id }; }
    const rawRef = input.raw ? (await this.media.ingest({ tenantId: src.tenantId, data: input.raw, kind: 'raw_email' })).key : null;
    const now = new Date().toISOString();
    const res = await this.db.tenantTx(src.tenantId, async (tx) => {
      const rows = await tx.insert(intakeRecords).values({
        tenantId: src.tenantId, sourceId: src.id, state: input.parsed ? 'parsed' : 'received', deliveryIdempotencyKey: deliveryKey, rawEmailRef: rawRef,
        parsedFields: input.parsed ? this.packParsed(input.parsed) : null, authEvidence: input.auth ?? null, parserVersion: src.parsingRules.parserVersion,
        submissionId: input.parsed?.fields.submissionId, messageId: input.parsed?.messageId, contentFingerprint: input.parsed?.fingerprint,
        timestamps: { received: input.receivedAt ?? now, ...(input.parsed ? { parsed: now } : {}) } satisfies IntakeTimestamps,
      }).onConflictDoNothing({ target: intakeRecords.deliveryIdempotencyKey }).returning({ id: intakeRecords.id });
      if (!rows.length) return null;
      await this.queue.sendInTx(tx, QUEUES.EMAIL_INTAKE, { recordId: rows[0].id } satisfies EmailIntakeJob, { tenantId: src.tenantId, idempotencyKey: `intake:${rows[0].id}` });
      return rows[0].id;
    });
    if (!res) { M.duplicateSuppressed().inc({ kind: 'intake_delivery' }); return { status: 'duplicate' }; }
    M.intakeResults().inc({ result: 'received' });
    return { status: 'accepted', recordId: res };
  }

  private packParsed(p: ParsedEmail): Record<string, unknown> {
    const meta: Meta = { templateMatched: p.templateMatched, senderAllowed: p.senderAllowed, suspicious: p.suspicious, missing: p.missingRequired, messageId: p.messageId, from: p.from, subject: p.subject };
    return { ...p.fields, _meta: meta, _fingerprint: p.fingerprint };
  }

  // ── process (worker) ────────────────────────────────────────
  async process(tenantId: string, recordId: string): Promise<void> {
    const [rec] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(intakeRecords).where(eq(intakeRecords.id, recordId)));
    if (!rec) return;
    if (['committing', 'committed', 'rejected', 'review'].includes(rec.state)) return; // replay-safe
    const [src] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(intakeSources).where(eq(intakeSources.id, rec.sourceId)));
    if (!src) throw new PermanentError('intake source no longer exists');

    let parsed: ParsedEmail;
    if (rec.parsedFields) {
      const { _meta, _fingerprint, ...fields } = rec.parsedFields as any;
      parsed = { fields, templateMatched: _meta?.templateMatched ?? true, senderAllowed: _meta?.senderAllowed ?? true, suspicious: _meta?.suspicious ?? [], missingRequired: _meta?.missing ?? [], fingerprint: _fingerprint ?? rec.contentFingerprint ?? '', parserVersion: src.parsingRules.parserVersion, text: '', messageId: _meta?.messageId, from: _meta?.from, subject: _meta?.subject };
    } else {
      if (!rec.rawEmailRef) throw new PermanentError('no email content to parse');
      try { parsed = await parseEmail(await this.media.load(tenantId, rec.rawEmailRef), src.parsingRules); }
      catch (e) { await this.setState(tenantId, rec.id, 'failed', { reviewReason: 'unparseable email', ts: 'failed' }); M.intakeResults().inc({ result: 'failed_parse' }); throw new PermanentError(`malformed email: ${(e as Error).message}`); }
      await this.db.tenantTx(tenantId, (tx) => tx.update(intakeRecords).set({
        state: 'parsed', parsedFields: this.packParsed(parsed) as any, submissionId: parsed.fields.submissionId, messageId: parsed.messageId, contentFingerprint: parsed.fingerprint,
        timestamps: { ...(rec.timestamps ?? {}), parsed: new Date().toISOString() }, updatedAt: new Date(),
      }).where(eq(intakeRecords.id, rec.id)));
    }

    if (await this.isDuplicate(tenantId, rec.id, src.id, parsed)) {
      await this.setState(tenantId, rec.id, 'rejected', { reviewReason: 'duplicate delivery of an already-processed enquiry' });
      M.intakeResults().inc({ result: 'duplicate' });
      await this.audit.write({ tenantId, action: 'intake.duplicate_suppressed', resourceType: 'intake_record', resourceId: rec.id });
      return;
    }
    await this.decide(tenantId, rec.id, src, parsed, rec.authEvidence ?? undefined, false);
  }

  private async isDuplicate(tenantId: string, recordId: string, sourceUuid: string, p: ParsedEmail): Promise<boolean> {
    const since = new Date(Date.now() - FINGERPRINT_WINDOW_HOURS * 3600_000);
    const conds: SQL[] = [];
    if (p.fields.submissionId) conds.push(eq(intakeRecords.submissionId, p.fields.submissionId));
    if (p.messageId) conds.push(eq(intakeRecords.messageId, p.messageId));
    // Content fingerprints only suppress copies that carry real content (message + a contact method).
    if (p.fingerprint && p.fields.message && (p.fields.email || p.fields.phone)) conds.push(and(eq(intakeRecords.contentFingerprint, p.fingerprint), gt(intakeRecords.createdAt, since))!);
    if (!conds.length) return false;
    const rows = await this.db.tenantTx(tenantId, (tx) =>
      tx.select({ id: intakeRecords.id }).from(intakeRecords).where(and(eq(intakeRecords.sourceId, sourceUuid), ne(intakeRecords.id, recordId), sql`${intakeRecords.state} in ('parsed','review','committing','committed')`, sql`${intakeRecords.createdAt} <= (select created_at from intake_records where id = ${recordId})`, or(...conds))).limit(1),
    );
    return rows.length > 0;
  }

  private async setState(tenantId: string, id: string, state: string, opts: { reviewReason?: string; ts?: keyof IntakeTimestamps } = {}): Promise<void> {
    await this.db.tenantTx(tenantId, async (tx) => {
      const [r] = await tx.select({ t: intakeRecords.timestamps }).from(intakeRecords).where(eq(intakeRecords.id, id));
      await tx.update(intakeRecords).set({ state, reviewReason: opts.reviewReason, timestamps: { ...(r?.t ?? {}), ...(opts.ts ? { [opts.ts]: new Date().toISOString() } : {}) }, updatedAt: new Date() }).where(eq(intakeRecords.id, id));
    });
  }

  /** Decide auto-save vs review. `force` is used only after an authorized human approved/corrected. */
  private async decide(tenantId: string, recordId: string, src: SourceRow, p: ParsedEmail, auth: Record<string, unknown> | undefined, force: boolean, approver?: string): Promise<void> {
    const tenant = await this.tenants.getContext(tenantId);
    const reasons: string[] = [];
    const f = p.fields;
    if (!meetsAutoSaveMinimum(f)) reasons.push('needs a name or company, a valid contact method and enquiry text');
    if (!force) {
      if (!p.senderAllowed) reasons.push('sender is not on the approved list');
      if (!p.templateMatched) reasons.push('template not recognised (the form may have changed)');
      if (p.missingRequired.length) reasons.push(`missing required: ${p.missingRequired.join(', ')}`);
      reasons.push(...p.suspicious);
      if (auth && ['fail', 'softfail'].includes(String((auth as any).dmarc ?? '').toLowerCase())) reasons.push('sender authentication failed');
      if (src.crmRouting.mode === 'review') reasons.push('source is in review mode');
    }

    // Duplicate contacts inside the tenant (IN-09), looked up with the integration role (tenant-wide).
    let existing: CaptureLeadAction['existing'];
    let fill: Record<string, string> | undefined;
    if (!reasons.length || force) {
      const people = new Map<string, Awaited<ReturnType<CrmAdapter['findPeople']>>[number]>();
      if (f.email) for (const x of await this.crm.findPeople(tenant, { scope: { kind: 'all' }, email: f.email, limit: 5 })) people.set(x.id, x);
      if (f.phone) for (const x of await this.crm.findPeople(tenant, { scope: { kind: 'all' }, phoneE164: f.phoneE164 ?? undefined, phoneDigits: f.phone.replace(/\D/g, ''), limit: 5 })) people.set(x.id, x);
      if (people.size > 1 && !force) reasons.push('email and phone match different existing contacts');
      else if (people.size >= 1) {
        const person = [...people.values()][0];
        const policy = src.crmRouting.repeatPolicy ?? 'review';
        existing = { personId: person.id, ...(person.companyId ? { companyId: person.companyId } : {}) };
        fill = {};
        if (f.email && !person.email) fill.email = f.email;
        if (f.phone && !person.phone && !person.phoneRaw) { fill.phoneRaw = f.phone; if (f.phoneE164) fill.phoneE164 = f.phoneE164; }
        if (policy === 'review' && !force) reasons.push('repeat enquiry from an existing contact');
        else if (policy === 'append_to_open' && !force) {
          const open = (await this.crm.listOpportunities(tenant, { scope: { kind: 'all' }, personId: person.id, maxRecords: 20 })).items.filter((o) => !tenant.pipeline.stages.find((s) => s.id === o.stageId)?.isTerminal);
          if (open.length === 1) existing.opportunityId = open[0].id;
          else if (open.length > 1) reasons.push('several open opportunities for this contact');
        }
      }
    }

    // Owner (IN-10): reuse a previously chosen owner so replays never advance round-robin twice.
    const [cur] = await this.db.tenantTx(tenantId, (tx) => tx.select({ pa: intakeRecords.proposedActions }).from(intakeRecords).where(eq(intakeRecords.id, recordId)));
    let owner: string | null = ((cur?.pa as any)?.[0]?.ownerUserId as string | undefined) ?? null;
    // A designated owner is deterministic, so review items carry it; round-robin only advances when the item is going to be saved.
    if (!owner && src.crmRouting.ownerUserId && (await this.identity.getActiveUser(tenantId, src.crmRouting.ownerUserId))) owner = src.crmRouting.ownerUserId;
    if (!owner && (!reasons.length || force)) owner = await this.assignment.pick(tenantId, src.id);
    if (!owner && (!reasons.length || force)) reasons.push('no eligible active owner (routed to the client admin review queue)');

    const action = this.buildAction(src, tenant.timezone, tenant.workingDays, recordId, f, existing, fill && Object.keys(fill).length ? fill : undefined, owner ?? undefined);

    if (reasons.length && !(force && !reasons.some((r) => r.startsWith('needs a name') || r.startsWith('no eligible')))) {
      await this.toReview(tenantId, recordId, src, p, action, reasons.join('; '));
      return;
    }
    await this.commit(tenantId, recordId, action, owner!, approver);
  }

  private buildAction(src: SourceRow, tz: string, workingDays: number[], recordId: string, f: ParsedFields, existing: CaptureLeadAction['existing'], fill: Record<string, string> | undefined, owner?: string): CaptureLeadAction {
    const display = [f.name, f.company].filter(Boolean).join(' — ') || 'Website enquiry';
    const fu = src.followUpConfig;
    const dueDate = fu?.taskDelayWorkingDays != null ? addWorkingDays(DateTime.now().setZone(tz).toISODate()!, fu.taskDelayWorkingDays, workingDays, tz) : undefined;
    const hasPerson = !existing?.personId && (f.name || f.email || f.phone);
    return CaptureLeadActionSchema.parse(JSON.parse(JSON.stringify({
      type: 'capture_lead',
      person: hasPerson ? { name: f.name ?? f.email ?? f.phone, email: f.email, phoneRaw: f.phone, phoneE164: f.phoneE164 ?? undefined, companyName: f.company } : undefined,
      company: !existing?.companyId && f.company ? { name: f.company } : undefined,
      opportunity: existing?.opportunityId ? undefined : { title: display, stageId: src.crmRouting.initialStage, source: src.crmRouting.sourceTag },
      notes: [{ type: 'enquiry', text: `Website enquiry${src.formLabel ? ` (${src.formLabel})` : ''} via ${src.sourceId}, record ${recordId.slice(0, 8)}:\n${f.message ?? ''}`.slice(0, 5000) }],
      tasks: dueDate ? [{ title: `Follow up: ${display} (website enquiry)`, type: 'follow_up', dueDate, timezone: tz }] : [],
      existing, personFill: fill, ownerUserId: owner,
    })));
  }

  private async toReview(tenantId: string, recordId: string, src: SourceRow, p: ParsedEmail, action: CaptureLeadAction, reason: string): Promise<void> {
    const tenant = await this.tenants.getContext(tenantId);
    await this.db.tenantTx(tenantId, async (tx) => {
      const [r] = await tx.select({ t: intakeRecords.timestamps }).from(intakeRecords).where(eq(intakeRecords.id, recordId));
      await tx.update(intakeRecords).set({ state: 'review', reviewReason: reason.slice(0, 255), proposedActions: [action as unknown as ProposedAction], timestamps: { ...(r?.t ?? {}), review: new Date().toISOString() }, updatedAt: new Date() }).where(eq(intakeRecords.id, recordId));
    });
    M.intakeResults().inc({ result: 'review' });
    await this.audit.write({ tenantId, action: 'intake.review_created', resourceType: 'intake_record', resourceId: recordId, metadata: { reason } });
    // Mirror into the tenant-restricted Intake Review view in Twenty (IN-11); the poller retries if Twenty is down.
    try {
      const rv = await this.crm.upsertIntakeReview(tenant, { recordId, sourceId: src.sourceId, reason, fields: { ...p.fields, message: (p.fields.message ?? '').slice(0, 1000) }, operationRef: `intake:${recordId}`, receivedAt: new Date().toISOString() });
      await this.db.tenantTx(tenantId, (tx) => tx.update(intakeRecords).set({ crmReviewId: rv.id }).where(eq(intakeRecords.id, recordId)));
    } catch (e) { this.log.warn({ err: (e as Error).message }, 'could not mirror review item to Twenty yet'); }
  }

  private async commit(tenantId: string, recordId: string, action: CaptureLeadAction, ownerUserId: string, approver?: string): Promise<void> {
    await this.db.tenantTx(tenantId, async (tx) => {
      const [r] = await tx.select().from(intakeRecords).where(eq(intakeRecords.id, recordId)).for('update');
      if (['committing', 'committed'].includes(r.state)) return; // second approval or replay: same operation
      const { op } = await this.journal.create(tx, { tenantId, userId: ownerUserId, type: 'capture_lead', channel: 'email', action, idempotencyKey: `intake:${recordId}`, sourceEventId: `intake:${recordId}` });
      await tx.update(intakeRecords).set({ state: 'committing', operationId: op.id, proposedActions: [action as unknown as ProposedAction], reviewedBy: approver ?? r.reviewedBy, updatedAt: new Date() }).where(eq(intakeRecords.id, recordId));
      await this.queue.sendInTx(tx, QUEUES.CRM_WRITE, { operationId: op.id } satisfies CrmWriteJob, { tenantId, userId: ownerUserId, idempotencyKey: `crm:${op.id}` });
      await this.audit.writeTx(tx, { tenantId, userId: ownerUserId, channel: 'email', action: approver ? 'intake.approved' : 'intake.auto_commit', resourceType: 'intake_record', resourceId: recordId, metadata: { approver } });
    });
  }

  /** CRM worker callback: finalize the intake record and send the optional internal notification (IN-10, IN-12). */
  async onOperationFinished(op: OperationRow): Promise<void> {
    if (op.channel !== 'email') return;
    const [rec] = await this.db.tenantTx(op.tenantId, (tx) => tx.select().from(intakeRecords).where(eq(intakeRecords.operationId, op.id)));
    if (!rec) return;
    const ok = op.state === 'committed';
    await this.setState(op.tenantId, rec.id, ok ? 'committed' : 'failed', { ts: ok ? 'saved' : 'failed', reviewReason: ok ? rec.reviewReason ?? undefined : String((op.errorInfo as any)?.message ?? 'save failed').slice(0, 255) });
    M.intakeResults().inc({ result: ok ? 'committed' : 'failed' });
    if (!ok) return;
    const [src] = await this.db.tenantTx(op.tenantId, (tx) => tx.select().from(intakeSources).where(eq(intakeSources.id, rec.sourceId)));
    if (!src?.followUpConfig?.notify) return;
    const tenant = await this.tenants.getContext(op.tenantId);
    const dest = tenant.settings.notificationDestination;
    if (!dest?.userId) return;
    const live = await this.identity.getActiveUser(op.tenantId, dest.userId);
    if (!live) return;
    const f = rec.parsedFields as any;
    const owner = await this.identity.getActiveUser(op.tenantId, op.userId);
    const url = (op.result as any)?.refs?.find((r: any) => r.kind === 'opportunity')?.url;
    await this.outbound.enqueue({ tenantId: op.tenantId, userId: dest.userId, channel: dest.channel, messageType: 'notification', idempotencyKey: `intake-notify:${rec.id}`, content: { kind: 'reply', text: `📥 New website enquiry from ${f?.name ?? f?.company ?? 'a visitor'}${f?.company && f?.name ? ` (${f.company})` : ''} — assigned to ${owner?.user.displayName ?? 'a salesperson'}.${url ? `\n${url}` : ''}` } });
  }

  /** Owner for a review item being approved (designated, else round-robin). */
  pickOwner(tenantId: string, sourceUuid: string): Promise<string | null> {
    return this.assignment.pick(tenantId, sourceUuid);
  }

  // ── review queue (IN-11) ────────────────────────────────────
  /**
   * Review queue (IN-11). Managers see only enquiries routed to a team they manage (or to themselves); unrouted items
   * form the client-admin queue (IN-10) that CXOs and client admins see. Without a viewer: the whole queue (system).
   */
  async listReview(tenantId: string, state: 'review' | 'failed' | 'committing' = 'review', viewer?: ReviewActor): Promise<IntakeRow[]> {
    const rows = await this.db.tenantTx(tenantId, (tx) => tx.select().from(intakeRecords).where(and(eq(intakeRecords.tenantId, tenantId), eq(intakeRecords.state, state))).orderBy(desc(intakeRecords.createdAt)).limit(100));
    if (!viewer) return rows;
    if (!can(viewer.role, 'intake.review')) return [];
    if (recordScopeOf(viewer.role) === 'all') return rows;
    const sources = await this.db.tenantTx(tenantId, (tx) => tx.select({ id: intakeSources.id, routing: intakeSources.crmRouting }).from(intakeSources).where(eq(intakeSources.tenantId, tenantId)));
    const teamOf = await this.teamsByUser(tenantId);
    return rows.filter((r) => this.inReviewScope(viewer, sources.find((s) => s.id === r.sourceId)?.routing as any, teamOf));
  }

  private async teamsByUser(tenantId: string): Promise<Map<string, string | null>> {
    const rows = await this.db.tenantTx(tenantId, (tx) => tx.select({ id: users.id, teamId: users.teamId }).from(users).where(eq(users.tenantId, tenantId)));
    return new Map(rows.map((u) => [u.id, u.teamId]));
  }

  /** A manager reviews items routed to a team they manage, to themselves, or to an owner in a team they manage. */
  private inReviewScope(viewer: ReviewActor, routing: { teamId?: string; ownerUserId?: string } | undefined, teamOf: Map<string, string | null>): boolean {
    if (recordScopeOf(viewer.role) === 'all') return true;
    if (!routing) return false;
    const managed = viewer.managedTeamIds ?? [];
    const ownerTeam = routing.ownerUserId ? teamOf.get(routing.ownerUserId) : undefined;
    return (!!routing.teamId && managed.includes(routing.teamId)) || routing.ownerUserId === viewer.id || (!!ownerTeam && managed.includes(ownerTeam));
  }

  private async assertReviewer(tenantId: string, actor: ReviewActor, rec: IntakeRow): Promise<void> {
    // Restricted users cannot approve (AT-20); managers only within the teams they manage (IN-10/IN-11).
    if (!can(actor.role, 'intake.review')) throw new UserFacingError('Only managers, CXOs or administrators can review enquiries.', 'REVIEW_FORBIDDEN');
    if (recordScopeOf(actor.role) === 'all') return;
    const [src] = await this.db.tenantTx(tenantId, (tx) => tx.select({ routing: intakeSources.crmRouting }).from(intakeSources).where(eq(intakeSources.id, rec.sourceId)));
    if (!this.inReviewScope(actor, src?.routing as any, await this.teamsByUser(tenantId))) throw new UserFacingError('Enquiry not found.', 'NOT_FOUND');
  }

  async approve(tenantId: string, recordId: string, actor: ReviewActor, corrections: Partial<ParsedFields> = {}): Promise<IntakeRow> {
    const [rec] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(intakeRecords).where(eq(intakeRecords.id, recordId)));
    if (!rec) throw new UserFacingError('Enquiry not found.', 'NOT_FOUND');
    await this.assertReviewer(tenantId, actor, rec);
    if (rec.state === 'committing' || rec.state === 'committed') return rec; // idempotent
    if (!['review', 'failed'].includes(rec.state)) throw new UserFacingError('This enquiry is not awaiting review.', 'BAD_STATE');
    const [src] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(intakeSources).where(eq(intakeSources.id, rec.sourceId)));
    const { _meta, _fingerprint, ...fields } = (rec.parsedFields ?? {}) as any;
    const merged: ParsedFields = { ...fields, ...Object.fromEntries(Object.entries(corrections).filter(([, v]) => v != null && v !== '')) };
    const parsed: ParsedEmail = { fields: merged, templateMatched: true, senderAllowed: true, suspicious: [], missingRequired: [], fingerprint: _fingerprint ?? '', parserVersion: src.parsingRules.parserVersion, text: '' };
    await this.db.tenantTx(tenantId, (tx) => tx.update(intakeRecords).set({ parsedFields: { ...merged, _meta, _fingerprint } as any, reviewedBy: actor.id, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(intakeRecords.id, recordId)));
    await this.decide(tenantId, recordId, src, parsed, undefined, true, actor.id);
    const [after] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(intakeRecords).where(eq(intakeRecords.id, recordId)));
    return after;
  }

  async reject(tenantId: string, recordId: string, actor: ReviewActor): Promise<IntakeRow> {
    const [rec] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(intakeRecords).where(eq(intakeRecords.id, recordId)));
    if (!rec) throw new UserFacingError('Enquiry not found.', 'NOT_FOUND');
    await this.assertReviewer(tenantId, actor, rec);
    if (rec.state === 'committing' || rec.state === 'committed') throw new UserFacingError('This enquiry was already saved.', 'BAD_STATE');
    await this.db.tenantTx(tenantId, (tx) => tx.update(intakeRecords).set({ state: 'rejected', reviewedBy: actor.id, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(intakeRecords.id, recordId)));
    await this.audit.write({ tenantId, userId: null, action: 'intake.rejected', resourceType: 'intake_record', resourceId: recordId, metadata: { by: actor.id } });
    M.intakeResults().inc({ result: 'rejected' });
    return { ...rec, state: 'rejected' };
  }

  /** Execute decisions made in the Twenty Intake Review view (approved/rejected) idempotently. */
  async pollTwentyReviews(tenantId: string): Promise<number> {
    const tenant = await this.tenants.getContext(tenantId);
    let n = 0;
    for (const status of ['approved', 'rejected'] as const) {
      for (const item of await this.crm.listIntakeReviews(tenant, status)) {
        const [rec] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(intakeRecords).where(eq(intakeRecords.id, item.recordId)));
        if (!rec || rec.state !== 'review') continue;
        // The decision was made in Twenty's own UI: it counts only if that member is linked to a Bee user allowed to review.
        const reviewer = item.reviewedBy ? await this.identity.resolveTwentyMember(tenantId, item.reviewedBy) : null;
        if (!reviewer) { await this.audit.write({ tenantId, action: 'intake.review_ignored', resourceType: 'intake_record', resourceId: rec.id, result: 'denied', metadata: { reason: 'unlinked or unauthorized Twenty reviewer', member: item.reviewedBy ?? null } }); continue; }
        const actor: ReviewActor = { id: reviewer.user.userId, role: reviewer.user.role, managedTeamIds: reviewer.user.managedTeamIds };
        try {
          if (status === 'approved') await this.approve(tenantId, rec.id, actor); else await this.reject(tenantId, rec.id, actor);
          n++;
        } catch (e) {
          await this.audit.write({ tenantId, userId: reviewer.user.userId, action: 'intake.review_ignored', resourceType: 'intake_record', resourceId: rec.id, result: 'denied', metadata: { reason: (e as Error).message } });
        }
      }
    }
    // Retry mirroring for review items created while Twenty was unavailable.
    const pending = await this.db.tenantTx(tenantId, (tx) => tx.select().from(intakeRecords).where(and(eq(intakeRecords.state, 'review'), sql`${intakeRecords.crmReviewId} is null`)).limit(20));
    for (const rec of pending) {
      try {
        const rv = await this.crm.upsertIntakeReview(tenant, { recordId: rec.id, sourceId: rec.sourceId, reason: rec.reviewReason ?? 'review', fields: (rec.parsedFields ?? {}) as any, operationRef: `intake:${rec.id}`, receivedAt: rec.createdAt.toISOString() });
        await this.db.tenantTx(tenantId, (tx) => tx.update(intakeRecords).set({ crmReviewId: rv.id }).where(eq(intakeRecords.id, rec.id)));
      } catch { /* try again next poll */ }
    }
    return n;
  }
}
