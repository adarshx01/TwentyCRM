import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { operations } from '../database/schema';
import type { NormalizedEvent } from '../common/schemas';
import type { ChannelName, TenantContext, UserContext } from '../common/types';
import { IdentityService, type ResolvedIdentity } from '../identity/identity.service';
import { OutboundService } from '../outbound/outbound.service';
import { QuotaService } from '../tenant/quota.service';
import { ExtractionService } from '../extraction/extraction.service';
import { MediaService } from '../media/media.service';
import { QueueService } from '../queue/queue.service';
import { QUEUES, type AiExtractionJob } from '../queue/queues';
import { DraftService, type DraftRow } from './draft.service';
import { ConfirmationService } from './confirmation.service';
import { DuplicateDetector } from './duplicate-detector.service';
import { MutationBuilder } from './mutation-builder';
import { ReplyService } from './reply.service';
import { ReportsService } from '../reports/reports.service';
import { ActionAuthorizer } from '../crm/operations/action-authorizer';
import { OperationJournal, type ExecutionOutcome, type OperationRow } from '../crm/operations/operation-journal.service';
import { OperationEffects } from '../crm/operations/operation-effects.service';
import { applyCard, applyContextText, applyEdit, applyIntent, answerClarification, answerTaskClarification, buildCaptureAction, nextStep, parseEdit, type CaptureEnv } from './capture-logic';
import { emptyCapture, type CaptureData, type DraftData, type MutationData } from './draft.types';
import { renderCapturePreview, renderClarification, renderMutationPreview } from './preview';
import { decodeButton, MEDIA_FETCHERS, type ChannelReply, type MediaFetchers } from '../channels/channel.types';
import { AllowedActionSchema, type LlmIntent } from '../common/schemas';
import { UserFacingError, errorMessage } from '../common/errors';
import { enrichContext } from '../common/context/request-context';
import { CRM_ADAPTER, type CrmAdapter } from '../crm/crm-adapter.interface';
import { AuditService } from '../audit/audit.service';
import { IntakeService } from '../intake/intake.service';
import { isRoleSufficient } from '../common/guards/roles.guard';
import { getLogger } from '../observability/logger';
import { M } from '../observability/metrics';

const CONFIRM = /^(confirm(ed)?|yes|y|ok(ay)?|save( it)?|go ahead|looks good|do it)[.! ]*$/i;
const CANCEL = /^(cancel|no|n|discard|stop|abort|never ?mind)[.! ]*$/i;
const HARD_CANCEL = /^(cancel|discard|abort)[.! ]*$/i;
const EDIT = /^edit[.! ]*$/i;
const HELP = /^(help|\?|menu|hi|hello|hey|start)[.! ]*$/i;
const ENROLL = /^(?:enrol(?:l)?\s+)?(BEE-[A-Z0-9]{4}-[A-Z0-9]{4})\s*$/i;

export const HELP_TEXT = [
  '*What I can do*',
  '• Send a business card photo and/or a voice note → I draft a lead for you to confirm',
  '• "Find Rajesh at ABC"',
  '• "Move this lead to Proposal" · "Met Rajesh today; proposal requested"',
  '• "Follow up next Tuesday" · "Move tomorrow\'s meeting to Friday at 3 PM"',
  '• "Who should I meet today?" · "Show my overdue follow-ups" · "Summarize ABC Industries"',
  '• "Show my team\'s pipeline" · "What did we win this month?"',
  'Nothing is saved until you confirm. Say "workspace" to switch client.',
].join('\n');

interface Ctx {
  id: ResolvedIdentity;
  tenant: TenantContext;
  user: UserContext;
  event: NormalizedEvent;
  channel: ChannelName;
  say(reply: ChannelReply | string): Promise<void>;
}

/**
 * Conversation orchestrator (Section 2): resolve tenant+user from verified bindings,
 * route to capture / command / query, never trust the model for identity or permissions.
 * The model only structures text; deterministic code authorizes and executes.
 */
@Injectable()
export class ConversationService {
  private readonly log = getLogger('conversation');

  constructor(
    private readonly db: DbService,
    private readonly identity: IdentityService,
    private readonly outbound: OutboundService,
    private readonly quota: QuotaService,
    private readonly extraction: ExtractionService,
    private readonly media: MediaService,
    private readonly queue: QueueService,
    private readonly drafts: DraftService,
    private readonly confirmation: ConfirmationService,
    private readonly dups: DuplicateDetector,
    private readonly mutations: MutationBuilder,
    private readonly replies: ReplyService,
    private readonly reports: ReportsService,
    private readonly authorizer: ActionAuthorizer,
    private readonly audit: AuditService,
    private readonly intake: IntakeService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    @Inject(MEDIA_FETCHERS) private readonly fetchers: MediaFetchers,
  ) {}

  // ── helpers ──────────────────────────────────────────────────
  private env(c: { tenant: TenantContext; user: UserContext }, nowIso: string): CaptureEnv {
    return {
      timezone: c.user.timezone, nowIso, defaultCountry: c.tenant.settings.defaultCountry, defaultCurrency: c.tenant.defaultCurrency,
      stageLabel: (id) => c.tenant.pipeline.stages.find((s) => s.id === id)?.label ?? id,
    };
  }

  private makeSay(tenant: TenantContext, user: UserContext, channel: ChannelName, keyBase: string): Ctx['say'] {
    let n = 0;
    return async (reply) => {
      const r = typeof reply === 'string' ? { text: reply } : reply;
      await this.replies.send({ tenantId: tenant.tenantId, userId: user.userId, channel }, r, `${keyBase}:${n++}`);
    };
  }

  // ── entry point ──────────────────────────────────────────────
  async handleEvent(event: NormalizedEvent): Promise<void> {
    const channel = event.channel as ChannelName;
    const key = { channel, connectionId: event.connectionId, externalId: event.externalSenderId };
    const text = event.text?.trim() ?? '';

    const enroll = ENROLL.exec(text);
    if (enroll) return this.handleEnroll(event, key, enroll[1].toUpperCase());

    const res = await this.identity.resolveInbound(key);
    if (res.kind === 'unknown') {
      // Unknown senders get no CRM information and no reply (IAM-02, WA-01).
      M.webhookReceived().inc({ channel, outcome: 'unknown_sender' });
      return;
    }
    if (res.kind === 'choose') return this.handleChoose(event, key, res.options, text);

    const { identity } = res;
    const { tenant, user } = identity;
    enrichContext({ tenantId: tenant.tenantId, userId: user.userId });
    const ctx: Ctx = { id: identity, tenant, user, event, channel, say: this.makeSay(tenant, user, channel, `evt:${event.providerEventId}`) };
    await this.identity.touchInbound(tenant.tenantId, identity.bindingId, event.conversationRef);
    // The employee wrote to us, so the 24h window is open: release any digest held behind a template (WA-03).
    await this.outbound.flushDeferred(tenant.tenantId, user.userId, channel).catch((e) => this.log.warn({ err: errorMessage(e) }, 'flushDeferred failed'));

    if (!(await this.quota.checkMessage(tenant))) return ctx.say('You are sending messages very quickly. Please wait a moment and try again.');
    if (HELP.test(text) && event.messageType === 'text') return ctx.say(HELP_TEXT);

    try {
      switch (event.messageType) {
        case 'interactive': case 'card_action': return await this.handleInteractive(ctx);
        case 'image': return await this.handleMedia(ctx, 'card');
        case 'audio': return await this.handleMedia(ctx, 'voice');
        case 'document': return await this.handleMedia(ctx, event.media?.[0]?.mimeType.startsWith('audio/') ? 'voice' : 'card');
        case 'text': return await this.handleText(ctx, text);
        default: return;
      }
    } catch (e) {
      if (e instanceof UserFacingError) return ctx.say(e.message);
      throw e;
    }
  }

  // ── enrollment & workspace choice ────────────────────────────
  private async handleEnroll(event: NormalizedEvent, key: { channel: ChannelName; connectionId: string; externalId: string }, code: string): Promise<void> {
    const ref = event.conversationRef;
    const r = await this.identity.redeemEnrollment(code, key, ref);
    const reply = r ? `You're connected to *${r.tenantName}*. Send "help" to see what I can do.` : 'That code is not valid or has expired. Please ask your administrator for a new one.';
    await this.replies.sendDirect(key.channel, key.connectionId, key.externalId, ref, { text: reply }, `enroll:${event.providerEventId}`);
  }

  private async handleChoose(event: NormalizedEvent, key: { channel: ChannelName; connectionId: string; externalId: string }, options: Array<{ tenantId: string; tenantName: string }>, text: string): Promise<void> {
    const reply = (t: string) => this.replies.sendDirect(key.channel, key.connectionId, key.externalId, event.conversationRef, { text: t }, `choose:${event.providerEventId}`);
    if (/^\d+$/.test(text)) {
      const picked = await this.identity.selectWorkspace(key, Number(text));
      if (picked) return reply(`Switched to *${options.find((o) => o.tenantId === picked.tenantId)?.tenantName ?? 'your workspace'}*. What would you like to do?`);
    }
    await this.identity.rememberChoices(key, options.map((o) => o.tenantId));
    await reply(['You belong to more than one workspace. Which one now?', ...options.map((o, i) => `${i + 1}. ${o.tenantName}`), 'Reply with a number.'].join('\n'));
  }

  // ── interactive (buttons) ────────────────────────────────────
  private async handleInteractive(ctx: Ctx): Promise<void> {
    const p = decodeButton(ctx.event.interactiveResponse?.id ?? '');
    if (!p) return ctx.say("I didn't recognise that button. Send \"help\" for options.");
    const draft = await this.drafts.get(ctx.tenant.tenantId, p.draftId);
    if (!draft || draft.userId !== ctx.user.userId || draft.conversationId !== ctx.event.conversationId) return ctx.say("I couldn't find that draft.");
    switch (p.action) {
      case 'confirm': return this.confirmDraft(ctx, draft.id, p.version, p.hash);
      case 'cancel': return this.cancelDraft(ctx, draft.id);
      case 'edit': return ctx.say(this.editHelp());
      case 'skip_note': case 'update_existing': case 'create_new': {
        if (draft.version !== p.version) return ctx.say('That button is out of date. Please use the latest message.');
        return this.applyDecisionButton(ctx, draft, p.action);
      }
    }
  }

  private editHelp(): string {
    return ['*Edit the draft* — reply with a correction, for example:', '• phone +91 98765 43210', '• email name@company.com', '• name / title / company / website / interest …', '• stage Proposal · amount 50000 INR', '• note: what was discussed', '• task: call Friday 3 PM · remove task', '• replace phone (overwrite an existing value)', 'I will show the updated preview. Older buttons stop working.'].join('\n');
  }

  private async applyDecisionButton(ctx: Ctx, draft: DraftRow, action: 'skip_note' | 'update_existing' | 'create_new'): Promise<void> {
    const data = draft.extractedData as unknown as CaptureData;
    if (data?.kind !== 'capture') return;
    const c = data.clarifications[0];
    if (action === 'skip_note') await this.updateCapture(ctx, draft, (d) => { d.contextSkipped = true; d.awaitingContext = false; });
    else if (c?.options) await this.updateCapture(ctx, draft, (d) => { answerClarification(d, action === 'create_new' ? String(d.clarifications[0].options!.length) : '1'); });
    await this.advance(ctx.tenant, ctx.user, ctx.channel, draft.id, `evt:${ctx.event.providerEventId}`);
  }

  // ── confirm / cancel ─────────────────────────────────────────
  private async confirmDraft(ctx: Ctx, draftId: string, version: number, hash: string): Promise<void> {
    const r = await this.confirmation.confirm({ tenant: ctx.tenant, user: ctx.user, draftId, version, hash, conversationId: ctx.event.conversationId, idempotencyKey: ctx.event.providerEventId });
    switch (r.status) {
      case 'started':
        return ctx.say(`✅ Confirmed. Saving now… (ref ${OperationEffects.reference(r.operationId)})\nI'll tell you exactly what was saved as soon as it finishes.`);
      case 'duplicate': {
        const op = await this.journalGet(ctx.tenant.tenantId, r.operationId);
        if (op?.state === 'committed') return ctx.say(this.successMessage(op, ctx.tenant));
        return ctx.say(`That confirmation was already received (ref ${OperationEffects.reference(r.operationId)}). It is being saved.`);
      }
      case 'stale': return this.resendCurrent(ctx, r.draft, 'That preview is out of date — your draft changed after it was sent. Here is the current one:');
      case 'record_changed': {
        await this.refreshAfterRecordChange(ctx, r.draft);
        return;
      }
      case 'rejected': return ctx.say(`I can't save this: ${r.message}`);
      case 'expired': return ctx.say('That draft expired after 30 minutes without changes, so nothing was saved. Please start again.');
      case 'cancelled': return ctx.say('That draft was cancelled; nothing was saved.');
      case 'not_confirmable': return ctx.say('That draft is not ready to confirm yet. Please answer my last question first.');
      case 'not_found': return ctx.say("I couldn't find that draft.");
    }
  }

  private async cancelDraft(ctx: Ctx, draftId: string): Promise<void> {
    const r = await this.drafts.cancel(ctx.tenant.tenantId, draftId, ctx.user.userId);
    return ctx.say(r === 'cancelled' ? '🗑️ Draft cancelled. Nothing was saved.' : r === 'not_active' ? 'That draft is no longer open, so nothing changed.' : "I couldn't find that draft.");
  }

  private async resendCurrent(ctx: Ctx, draft: DraftRow, intro: string): Promise<void> {
    const fresh = (await this.drafts.get(ctx.tenant.tenantId, draft.id)) ?? draft;
    if (fresh.state !== 'awaiting_confirmation') {
      return ctx.say(fresh.state === 'committing' || fresh.state === 'committed' ? 'That draft was already confirmed.' : fresh.state === 'cancelled' ? 'That draft was cancelled; nothing was saved.' : fresh.state === 'expired' ? 'That draft expired; nothing was saved.' : 'Please answer my last question about the draft first.');
    }
    await ctx.say(intro);
    await ctx.say(this.previewFor(ctx.tenant, ctx.user, fresh));
  }

  private previewFor(tenant: TenantContext, user: UserContext, draft: DraftRow): ChannelReply {
    const data = draft.extractedData as unknown as DraftData;
    if (data.kind === 'mutation') return renderMutationPreview(draft, data);
    const action = AllowedActionSchema.parse(draft.proposedActions[0]);
    return renderCapturePreview(draft, data, action as any, user.displayName, (id) => tenant.pipeline.stages.find((s) => s.id === id)?.label ?? id);
  }

  /** The target changed after the preview: re-read, show a fresh preview, require new confirmation (ACT-03). */
  private async refreshAfterRecordChange(ctx: Ctx, draft: DraftRow): Promise<void> {
    const data = draft.extractedData as unknown as DraftData;
    if (data.kind === 'capture') {
      await this.updateCapture(ctx, draft, (d) => { d.matches.signature = undefined; });
      await ctx.say('The record changed after your preview, so I re-checked it. Please review the updated preview.');
      return this.advance(ctx.tenant, ctx.user, ctx.channel, draft.id, `evt:${ctx.event.providerEventId}:r`);
    }
    // Mutation: rebuild from the current record state.
    const action = AllowedActionSchema.parse(draft.proposedActions[0]);
    const rebuilt = await this.rebuildMutation(ctx, action);
    if (!rebuilt) return ctx.say('That record changed and the request no longer applies. Nothing was saved.');
    await this.drafts.mutate(ctx.tenant.tenantId, draft.id, () => ({ data: rebuilt.data, actions: [rebuilt.action as any], state: 'awaiting_confirmation', bumpVersion: true }));
    await ctx.say('The record changed after your preview, so I re-read it. Please review the updated preview.');
    const fresh = (await this.drafts.get(ctx.tenant.tenantId, draft.id))!;
    return ctx.say(this.previewFor(ctx.tenant, ctx.user, fresh));
  }

  private async rebuildMutation(ctx: Ctx, action: ReturnType<typeof AllowedActionSchema.parse>): Promise<{ action: any; data: MutationData } | null> {
    const intent = this.intentFromAction(action);
    if (!intent) return null;
    const entity = (action as any).targetType ?? (action.type === 'update_stage' ? 'opportunity' : action.type === 'reschedule' ? 'task' : undefined);
    const id = (action as any).targetId ?? (action as any).opportunityId ?? (action as any).taskId;
    if (!entity || !id) return null;
    const res = await this.mutations.build(ctx.tenant, ctx.user, intent, { entity, id, label: 'record' }, new Date().toISOString());
    return res.kind === 'ready' ? { action: res.action, data: res.data } : null;
  }

  private intentFromAction(a: ReturnType<typeof AllowedActionSchema.parse>): LlmIntent | null {
    switch (a.type) {
      case 'update_stage': return { intent: 'update_stage', newStage: a.newStageId };
      case 'add_note': return { intent: 'add_note', notes: [a.note.text] };
      case 'archive': return { intent: 'archive' };
      case 'restore': return { intent: 'restore' };
      default: return null; // reschedule/assign/create_task: ask the user to repeat the request
    }
  }

  private async journalGet(tenantId: string, id: string): Promise<OperationRow | null> {
    return (await this.db.tenantTx(tenantId, async (tx) => (await tx.select().from(operations).where(eq(operations.id, id)))[0])) ?? null;
  }

  // ── media ────────────────────────────────────────────────────
  private async handleMedia(ctx: Ctx, kind: 'card' | 'voice'): Promise<void> {
    const m = ctx.event.media?.[0];
    if (!m) return ctx.say('I could not find an attachment in that message.');
    await this.quota.checkUpload(ctx.tenant);
    const now = ctx.event.receivedAt;
    const active = (await this.drafts.listActive(ctx.tenant.tenantId, ctx.user.userId, ctx.event.conversationId)).filter((d) => (d.extractedData as any)?.kind === 'capture');
    // Attach to the draft being built if it is unambiguous and recent; never silently to "the last lead" (CAP-02).
    const linked = ctx.event.replyToId ? active.find((d) => d.previewMessageId === ctx.event.replyToId || d.sourceEventIds.includes(ctx.event.replyToId!)) : undefined;
    const recent = active.filter((d) => d.state === 'collecting' || Date.now() - d.updatedAt.getTime() < 120_000);
    let draft = linked ?? (active.length === 1 && recent.length === 1 ? recent[0] : undefined);
    if (!draft && active.length > 1) return ctx.say('You have several open drafts. Reply to the preview of the draft this belongs to, or cancel the others first.');

    const env = this.env(ctx, now);
    if (!draft) {
      const data = emptyCapture(ctx.tenant.pipeline.defaultInitialStage);
      data.pending[kind]++;
      data.awaitingContext = kind === 'card';
      draft = await this.drafts.create({ tenantId: ctx.tenant.tenantId, userId: ctx.user.userId, conversationId: ctx.event.conversationId, channel: ctx.channel, kind: 'capture', data, sourceEventId: ctx.event.providerEventId });
    } else {
      await this.updateCapture(ctx, draft, (d) => { d.pending[kind]++; if (kind === 'card' && d.notes.length === 0 && d.tasks.length === 0) d.awaitingContext = true; }, { backToCollecting: true });
    }
    void env;
    await this.queue.send(QUEUES.AI_EXTRACTION, {
      draftId: draft.id, kind, sourceEventId: ctx.event.providerEventId, channel: ctx.channel, connectionId: ctx.event.connectionId, receivedAt: ctx.event.receivedAt,
      descriptor: { mediaId: m.mediaId, mimeType: m.mimeType, url: m.url, filename: m.filename, size: m.size },
    } satisfies AiExtractionJob, { tenantId: ctx.tenant.tenantId, userId: ctx.user.userId, idempotencyKey: `ai:${ctx.event.providerEventId}:${m.mediaId}` });
    await ctx.say(kind === 'card' ? '📇 Got the card — reading it now…' : '🎙️ Got your voice note — transcribing…');
  }

  /** AI worker entry: download → validate → extract → merge into the draft → continue the conversation. */
  async processMedia(tenantId: string, userId: string, job: AiExtractionJob): Promise<void> {
    const live = await this.identity.getActiveUser(tenantId, userId);
    if (!live) { await this.drafts.cancel(tenantId, job.draftId, userId).catch(() => undefined); return; }
    const { tenant, user } = live;
    const draft = await this.drafts.get(tenantId, job.draftId);
    if (!draft || !['collecting', 'awaiting_confirmation'].includes(draft.state)) return;
    const d0 = draft.extractedData as unknown as CaptureData;
    if (d0.processed?.includes(job.sourceEventId)) return; // job replay
    const slot = await this.quota.acquireAiSlot(tenant);
    const say = this.makeSay(tenant, user, job.channel, `ai:${job.sourceEventId}`);
    const nowIso = job.receivedAt;
    const env = this.env({ tenant, user }, nowIso);
    try {
      const fetcher = this.fetchers[job.channel];
      if (!fetcher) throw new UserFacingError('This channel cannot deliver attachments right now.');
      const { data: bytes, mimeType } = await fetcher.fetch(job.descriptor, { tenantId, connectionId: job.connectionId });
      const ref = await this.media.ingest({ tenantId, data: bytes, declaredMime: mimeType ?? job.descriptor.mimeType, kind: job.kind, draftId: job.draftId });

      let apply: (d: CaptureData) => void;
      if (job.kind === 'card') {
        const card = await this.extraction.extractCard(tenant, bytes, ref.mimeType);
        apply = (d) => applyCard(d, card, env);
      } else {
        const { text } = await this.extraction.transcribe(tenant, bytes, ref.mimeType);
        if (!text) throw new UserFacingError("I couldn't hear anything in that voice note. Please try again or type the details.");
        let intent: LlmIntent | null = null;
        try { intent = await this.extraction.classify(tenant, { text, context: { nowIso, timezone: user.timezone, stageLabels: tenant.pipeline.stages.map((s) => s.label), hasActiveDraft: true, cardPresent: d0.fieldSources.name === 'card' } }); } catch (e) { this.log.warn({ err: errorMessage(e) }, 'intent extraction failed; keeping transcript as a note'); }
        apply = (d) => {
          d.pending.voice = Math.max(0, d.pending.voice - 1);
          if (intent && (intent.intent === 'capture_lead' || intent.intent === 'add_note' || intent.intent === 'create_task' || intent.intent === 'unknown')) applyIntent(d, intent, text, 'voice', env);
          else applyContextText(d, text, 'voice');
          if (!intent || (intent.confidence ?? 1) < 0.7) d.uncertain.push({ field: 'voice transcript', reason: 'automatic transcription — please check names, numbers and dates' });
        };
      }
      await this.drafts.mutate(tenantId, job.draftId, (row) => {
        if (!['collecting', 'awaiting_confirmation'].includes(row.state)) return null;
        const d = structuredClone(row.extractedData as unknown as CaptureData);
        if (d.processed.includes(job.sourceEventId)) return null;
        apply(d);
        d.processed.push(job.sourceEventId);
        d.matches.signature = undefined;
        return { data: d, state: 'collecting', actions: [], bumpVersion: true, mediaRefs: [...row.mediaRefs, ref], addEventId: job.sourceEventId };
      });
    } catch (e) {
      if (e instanceof UserFacingError) {
        await this.releasePending(tenantId, job, job.sourceEventId);
        await say(e.message);
        await this.advance(tenant, user, job.channel, job.draftId, `ai:${job.sourceEventId}:f`);
        return;
      }
      throw e;
    } finally {
      await slot.release();
    }
    await this.advance(tenant, user, job.channel, job.draftId, `ai:${job.sourceEventId}`);
  }

  /** Called when AI retries are exhausted: free the draft instead of leaving it waiting forever. */
  async onAiFinalFailure(tenantId: string, userId: string, job: AiExtractionJob): Promise<void> {
    await this.releasePending(tenantId, job, job.sourceEventId);
    const live = await this.identity.getActiveUser(tenantId, userId);
    if (!live) return;
    await this.makeSay(live.tenant, live.user, job.channel, `ai:${job.sourceEventId}:dead`)("I couldn't process that attachment after several tries. Please send it again, or type the details instead.");
    await this.advance(live.tenant, live.user, job.channel, job.draftId, `ai:${job.sourceEventId}:dead`).catch(() => undefined);
  }

  private async releasePending(tenantId: string, job: AiExtractionJob, sourceEventId: string): Promise<void> {
    await this.drafts.mutate(tenantId, job.draftId, (row) => {
      if (!['collecting', 'awaiting_confirmation'].includes(row.state)) return null;
      const d = structuredClone(row.extractedData as unknown as CaptureData);
      if (d.processed.includes(sourceEventId)) return null;
      d.pending[job.kind] = Math.max(0, d.pending[job.kind] - 1);
      d.processed.push(sourceEventId);
      return { data: d, bumpVersion: true };
    });
  }

  // ── text routing ─────────────────────────────────────────────
  private async handleText(ctx: Ctx, text: string): Promise<void> {
    if (!text) return;
    if (/^(workspace|switch workspace|change workspace)[.! ]*$/i.test(text)) {
      const key = { channel: ctx.channel, connectionId: ctx.event.connectionId, externalId: ctx.event.externalSenderId };
      const ms = await this.identity.listMemberships(key);
      if (ms.length < 2) return ctx.say(`You are connected to *${ctx.tenant.tenantSlug}* only.`);
      await this.identity.rememberChoices(key, ms.map((m) => m.tenantId));
      await this.identity.clearActive(key);
      return ctx.say(['Which workspace?', ...ms.map((m, i) => `${i + 1}. ${m.tenantName}`), 'Reply with a number.'].join('\n'));
    }
    // Intake review from chat (IN-11): list, approve through the normal preview/confirm flow, or reject.
    const review = /^(review|pending enquiries|enquiry review)[.! ]*$/i.test(text) ? 'list' : /^(approve|reject)\s+([0-9a-f]{6,8})\b/i.exec(text);
    if (review) return this.handleIntakeReview(ctx, review);
    let forceNew = false;
    const newMatch = /^new\s*[:-]\s*([\s\S]+)$/i.exec(text);
    if (newMatch) { text = newMatch[1].trim(); forceNew = true; }

    const active = forceNew ? [] : await this.drafts.listActive(ctx.tenant.tenantId, ctx.user.userId, ctx.event.conversationId);
    const linked = ctx.event.replyToId ? active.find((d) => d.previewMessageId === ctx.event.replyToId || d.sourceEventIds.includes(ctx.event.replyToId!)) : undefined;
    const needsAnswer = (d: DraftRow) => { const x = d.extractedData as any; return Boolean(x?.clarifications?.length || x?.pendingChoice || (x?.kind === 'capture' && x.awaitingContext)); };
    const waiting = active.filter(needsAnswer);
    // A single draft is the target; with several, only a draft that is actually waiting for an answer can claim a reply.
    const target = linked ?? (active.length === 1 ? active[0] : waiting.length === 1 && /^\d+$/.test(text.trim()) ? waiting[0] : undefined);

    // Decisions apply to a draft; with several candidates we must ask which one (CAP-02).
    if (CONFIRM.test(text) || EDIT.test(text) || CANCEL.test(text)) {
      const collectingQ = target && (target.extractedData as any)?.clarifications?.length && !HARD_CANCEL.test(text) && !EDIT.test(text);
      if (!collectingQ) {
        if (!active.length) return ctx.say('There is nothing waiting for confirmation.');
        if (!target) return ctx.say(['You have several open drafts. Reply to the preview of the one you mean, or:', ...active.slice(0, 5).map((d, i) => `${i + 1}. ${this.draftLabel(d)}`)].join('\n'));
        if (CONFIRM.test(text)) {
          if (target.state !== 'awaiting_confirmation') return ctx.say('That draft is not ready to confirm yet — please answer my last question first.');
          return this.confirmDraft(ctx, target.id, target.version, target.contentHash ?? '');
        }
        if (EDIT.test(text)) return ctx.say(this.editHelp());
        return this.cancelDraft(ctx, target.id);
      }
    }

    if (target) {
      const data = target.extractedData as unknown as DraftData;
      if (data.kind === 'capture') return this.handleCaptureText(ctx, target, data, text, Boolean(linked));
      if (data.kind === 'mutation' && data.pendingChoice) {
        if (/^\d+$/.test(text.trim())) return this.handleMutationChoice(ctx, target, data, text);
        await this.drafts.cancel(ctx.tenant.tenantId, target.id, ctx.user.userId); // a new request replaces an unanswered question
      }
      // A pending mutation preview does not block a different request: each draft has its own buttons.
    }

    return this.handleNewRequest(ctx, text);
  }

  private async handleIntakeReview(ctx: Ctx, cmd: 'list' | RegExpExecArray): Promise<void> {
    if (!isRoleSufficient(ctx.user.role, 'manager')) return ctx.say('Only managers, CXOs and administrators can review website enquiries.');
    if (cmd === 'list') {
      const items = await this.intake.listReview(ctx.tenant.tenantId);
      if (!items.length) return ctx.say('No website enquiries are waiting for review.');
      return ctx.say(['*Enquiries waiting for review*', ...items.slice(0, 10).map((r) => { const f = (r.parsedFields ?? {}) as any; return `• ${r.id.slice(0, 8)} — ${f.name ?? f.company ?? 'visitor'}${f.company && f.name ? ` (${f.company})` : ''}: ${r.reviewReason ?? 'review'}`; }), 'Reply "approve <id>" to preview and save, or "reject <id>".'].join('\n'));
    }
    const [, verb, prefix] = cmd;
    const items = (await this.intake.listReview(ctx.tenant.tenantId)).filter((r) => r.id.startsWith(prefix.toLowerCase()));
    if (items.length !== 1) return ctx.say(items.length ? 'That id is ambiguous; please use more characters.' : "I couldn't find that enquiry in the review queue.");
    const rec = items[0];
    if (verb.toLowerCase() === 'reject') {
      await this.intake.reject(ctx.tenant.tenantId, rec.id, { id: ctx.user.userId, role: ctx.user.role });
      return ctx.say(`Rejected enquiry ${rec.id.slice(0, 8)}. No opportunity was created.`);
    }
    let action = (rec.proposedActions ?? [])[0] as any;
    if (!action) return ctx.say("I can't build a preview for this enquiry. Please review it in Twenty.");
    if (!action.ownerUserId) {
      const owner = await this.intake.pickOwner(ctx.tenant.tenantId, rec.sourceId);
      if (!owner) return ctx.say('There is no eligible active owner for this source. Ask an administrator to configure one, then try again.');
      action = { ...action, ownerUserId: owner };
    }
    const parsed = AllowedActionSchema.safeParse(action);
    if (!parsed.success) return ctx.say("I can't build a safe preview for this enquiry. Please review it in Twenty.");
    const f = (rec.parsedFields ?? {}) as any;
    const data: MutationData = { kind: 'mutation', intakeRecordId: rec.id, summaryLines: [`*Approve website enquiry ${rec.id.slice(0, 8)}*`, `Contact: ${f.name ?? '—'}${f.email ? ` · ${f.email}` : ''}${f.phone ? ` · ${f.phone}` : ''}`, ...(f.company ? [`Company: ${f.company}`] : []), `Opportunity: ${(parsed.data as any).opportunity?.title ?? 'existing'}`, `Why it was held: ${rec.reviewReason ?? 'review'}`, f.message ? `Message: ${String(f.message).slice(0, 300)}` : ''].filter(Boolean), warnings: [] };
    const draft = await this.drafts.create({ tenantId: ctx.tenant.tenantId, userId: ctx.user.userId, conversationId: ctx.event.conversationId, channel: ctx.channel, kind: 'mutation', data, actions: [parsed.data as any], state: 'awaiting_confirmation', sourceEventId: ctx.event.providerEventId });
    return ctx.say(renderMutationPreview(draft, data));
  }

  private draftLabel(d: DraftRow): string {
    const data = d.extractedData as any;
    return data?.kind === 'capture' ? `Lead: ${data.person?.name ?? data.company?.name ?? 'unnamed'} (${d.state})` : `Change (${d.state})`;
  }

  private async handleCaptureText(ctx: Ctx, draft: DraftRow, data: CaptureData, text: string, linked: boolean): Promise<void> {
    const env = this.env(ctx, ctx.event.receivedAt);
    const stageIdFor = (l: string) => this.mutations.stageIdFor(ctx.tenant, l);

    // 1) answer the open question
    if (data.clarifications.length) {
      const c = data.clarifications[0];
      let failure: string | undefined;
      await this.updateCapture(ctx, draft, (d) => {
        const edit = parseEdit(text);
        const r = c.options ? answerClarification(d, text) : answerTaskClarification(d, text, env);
        if (!r.ok) {
          if (edit) { const er = applyEdit(d, edit, env, stageIdFor); if (!er.ok) failure = er.message; return; }
          failure = r.message ?? 'Sorry, I did not understand. Please answer the question above.';
        }
      });
      if (failure) return ctx.say(failure);
      return this.advance(ctx.tenant, ctx.user, ctx.channel, draft.id, `evt:${ctx.event.providerEventId}`);
    }
    // 2) a correction in the grammar
    const edit = parseEdit(text);
    if (edit) {
      let failure: string | undefined;
      await this.updateCapture(ctx, draft, (d) => { const r = applyEdit(d, edit, env, stageIdFor); if (!r.ok) failure = r.message; }, { backToCollecting: true });
      if (failure) return ctx.say(failure);
      return this.advance(ctx.tenant, ctx.user, ctx.channel, draft.id, `evt:${ctx.event.providerEventId}`);
    }
    // 3) context for a card-only draft
    if (data.awaitingContext) {
      const intent = await this.classify(ctx, text, true);
      await this.updateCapture(ctx, draft, (d) => { if (intent && ['capture_lead', 'add_note', 'create_task', 'unknown'].includes(intent.intent)) applyIntent(d, intent, text, 'text', env); else applyContextText(d, text, 'text'); d.matches.signature = undefined; });
      return this.advance(ctx.tenant, ctx.user, ctx.channel, draft.id, `evt:${ctx.event.providerEventId}`);
    }
    if (linked) return ctx.say("I didn't understand that edit.\n" + this.editHelp());
    // Never silently attach text to an existing lead (CAP-02).
    return ctx.say('You have an open draft. Reply to its preview to change it, say Confirm or Cancel, or start another lead with "new: …".');
  }

  private async handleMutationChoice(ctx: Ctx, draft: DraftRow, data: MutationData, text: string): Promise<void> {
    const pc = data.pendingChoice!;
    const n = Number(text.trim());
    const choice = Number.isInteger(n) ? pc.choices[n - 1] : undefined;
    if (!choice) return ctx.say(`Please reply with a number from 1 to ${pc.choices.length}, or Cancel.`);
    const intent = pc.intent as LlmIntent;
    const res = await this.mutations.build(ctx.tenant, ctx.user, intent, choice, ctx.event.receivedAt);
    await this.finishMutation(ctx, res, intent, draft);
  }

  private async classify(ctx: Ctx, text: string, hasActiveDraft: boolean): Promise<LlmIntent | null> {
    try {
      return await this.extraction.classify(ctx.tenant, { text, context: { nowIso: ctx.event.receivedAt, timezone: ctx.user.timezone, stageLabels: ctx.tenant.pipeline.stages.map((s) => s.label), hasActiveDraft, cardPresent: false } });
    } catch (e) {
      this.log.warn({ err: errorMessage(e) }, 'intent classification failed');
      return null;
    }
  }

  private async handleNewRequest(ctx: Ctx, text: string): Promise<void> {
    const intent = await this.classify(ctx, text, false);
    if (!intent) return ctx.say("I couldn't understand that just now. Please try again, or send \"help\".");
    const env = this.env(ctx, ctx.event.receivedAt);
    switch (intent.intent) {
      case 'capture_lead': {
        const data = emptyCapture(ctx.tenant.pipeline.defaultInitialStage);
        applyIntent(data, intent, text, 'text', env);
        const draft = await this.drafts.create({ tenantId: ctx.tenant.tenantId, userId: ctx.user.userId, conversationId: ctx.event.conversationId, channel: ctx.channel, kind: 'capture', data, sourceEventId: ctx.event.providerEventId });
        return this.advance(ctx.tenant, ctx.user, ctx.channel, draft.id, `evt:${ctx.event.providerEventId}`);
      }
      case 'search': {
        if (!intent.targetQuery) return ctx.say('Who or what should I look for? For example: "Find Rajesh at ABC".');
        const found = await this.mutations.find(ctx.tenant, ctx.user, intent.targetQuery);
        if (!found.length) return ctx.say(`No matching records for "${intent.targetQuery}" in your accessible records.`);
        return ctx.say([`Matches for "${intent.targetQuery}":`, ...found.slice(0, 8).map((f, i) => `${i + 1}. ${f.label}\n   ${this.crm.recordUrl(ctx.tenant, f.entity as any, f.id)}`), found.length > 8 ? `…and ${found.length - 8} more — refine your search.` : ''].filter(Boolean).join('\n'));
      }
      case 'summary': {
        if (!intent.summaryType) return ctx.say('Which report? Try "Who should I meet today?", "Show my overdue follow-ups", "Summarize ABC Industries", "Show my team\'s pipeline" or "What did we win this month?".');
        const r = await this.reports.run(intent.summaryType, ctx.tenant, ctx.user, { target: intent.targetQuery });
        if (r.needsChoice) return ctx.say([r.text, ...r.needsChoice.map((c, i) => `${i + 1}. ${c.label}`), 'Please repeat with the full company name.'].join('\n'));
        return ctx.say(r.text);
      }
      case 'update_stage': case 'add_note': case 'create_task': case 'reschedule': case 'assign': case 'archive': case 'restore': {
        const res = await this.mutations.build(ctx.tenant, ctx.user, intent, undefined, ctx.event.receivedAt);
        if (res.kind === 'ready' && intent.intent === 'add_note' && !intent.notes?.length) {
          // Keep the user's own words (not the model's paraphrase) as the note text.
          (res.action as any).note.text = text.slice(0, 4000);
        }
        return this.finishMutation(ctx, res, intent);
      }
      case 'clarify': return ctx.say(intent.clarification ?? 'Could you tell me a bit more?');
      default: return ctx.say(HELP_TEXT);
    }
  }

  private async finishMutation(ctx: Ctx, res: Awaited<ReturnType<MutationBuilder['build']>>, intent: LlmIntent, existing?: DraftRow): Promise<void> {
    if (res.kind === 'message') { if (existing) await this.drafts.cancel(ctx.tenant.tenantId, existing.id, ctx.user.userId); return ctx.say(res.text); }
    if (res.kind === 'choose') {
      const data: MutationData = { kind: 'mutation', summaryLines: [], warnings: [], pendingChoice: { intent: intent as Record<string, unknown>, choices: res.choices } };
      if (existing) await this.drafts.cancel(ctx.tenant.tenantId, existing.id, ctx.user.userId);
      await this.drafts.create({ tenantId: ctx.tenant.tenantId, userId: ctx.user.userId, conversationId: ctx.event.conversationId, channel: ctx.channel, kind: 'mutation', data, sourceEventId: ctx.event.providerEventId });
      return ctx.say(renderClarification(res.question, res.choices));
    }
    const auth = await this.authorizer.authorize(ctx.tenant, ctx.user, res.action);
    if (!auth.ok) { if (existing) await this.drafts.cancel(ctx.tenant.tenantId, existing.id, ctx.user.userId); return ctx.say(auth.message); }
    let draft: DraftRow;
    if (existing) {
      const r = await this.drafts.mutate(ctx.tenant.tenantId, existing.id, () => ({ data: res.data, actions: [res.action as any], state: 'awaiting_confirmation', bumpVersion: true }));
      draft = r!.row;
    } else {
      draft = await this.drafts.create({ tenantId: ctx.tenant.tenantId, userId: ctx.user.userId, conversationId: ctx.event.conversationId, channel: ctx.channel, kind: 'mutation', data: res.data, actions: [res.action as any], state: 'awaiting_confirmation', sourceEventId: ctx.event.providerEventId });
    }
    return ctx.say(renderMutationPreview(draft, res.data));
  }

  // ── draft progression shared by chat and AI worker ───────────
  private async updateCapture(ctx: { tenant: TenantContext; user: UserContext }, draft: DraftRow, fn: (d: CaptureData) => void, opts: { backToCollecting?: boolean } = {}): Promise<DraftRow> {
    const r = await this.drafts.mutate(ctx.tenant.tenantId, draft.id, (row) => {
      if (!['collecting', 'awaiting_confirmation'].includes(row.state)) return null;
      const d = structuredClone(row.extractedData as unknown as CaptureData);
      fn(d);
      return { data: d, state: 'collecting', actions: [], bumpVersion: true };
    });
    void opts;
    return r?.row ?? draft;
  }

  /**
   * Re-evaluate a capture draft: duplicates → open questions → preview. CRM reads happen
   * outside the row lock; the write is optimistic on the draft version and retried.
   */
  async advance(tenant: TenantContext, user: UserContext, channel: ChannelName, draftId: string, replyKey: string): Promise<void> {
    const say = this.makeSay(tenant, user, channel, replyKey);
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await this.drafts.get(tenant.tenantId, draftId);
      if (!row || !['collecting', 'awaiting_confirmation'].includes(row.state)) return;
      const data = structuredClone(row.extractedData as unknown as DraftData);
      if (data.kind !== 'capture') return;
      const live = await this.identity.getActiveUser(tenant.tenantId, user.userId);
      if (!live) { await this.drafts.cancel(tenant.tenantId, draftId, user.userId); return; }

      let step = nextStep(data);
      if (step.kind !== 'processing' && step.kind !== 'need_context') {
        await this.dups.refresh(tenant, user, data);
        if (data.decisions.person && data.decisions.person !== 'new') await this.dups.askOpportunityTarget(tenant, user, data);
        step = nextStep(data);
      }
      let action: ReturnType<typeof buildCaptureAction> | undefined;
      let authMessage: string | undefined;
      if (step.kind === 'ready') {
        action = buildCaptureAction(data, undefined);
        const auth = await this.authorizer.authorize(tenant, user, action);
        if (!auth.ok) { authMessage = auth.message; action = undefined; }
      }
      if (step.kind === 'need_context') data.contextAsked = true;

      const saved = await this.drafts.mutate(tenant.tenantId, draftId, (cur) => {
        if (cur.version !== row.version || !['collecting', 'awaiting_confirmation'].includes(cur.state)) return null; // changed under us: retry
        return step.kind === 'ready' && action
          ? { data, actions: [action as any], state: 'awaiting_confirmation', bumpVersion: true }
          : { data, state: 'collecting', actions: [], bumpVersion: data.matches.signature !== (row.extractedData as any)?.matches?.signature || step.kind === 'need_context' || step.kind === 'clarify' };
      });
      if (!saved || !saved.changed) continue;

      const fresh = saved.row;
      switch (step.kind) {
        case 'processing': return;
        case 'need_context':
          if ((row.extractedData as any).contextAsked) return;
          return say({ text: '📇 I have the card details. Add context (what was discussed, interest, a next step) as text or a voice note — or continue without a note.', buttons: [{ id: `d|${fresh.id}|${fresh.version}|${'0'.repeat(8)}|skip_note`, title: 'Continue without note' }] });
        case 'clarify': {
          const c = step.clarification;
          const two = c.options && c.options.length === 2 && ['match_person', 'match_company'].includes(c.kind);
          return say(renderClarification(c.question, c.options, two ? [
            { id: `d|${fresh.id}|${fresh.version}|${'0'.repeat(8)}|update_existing`, title: 'Update existing' },
            { id: `d|${fresh.id}|${fresh.version}|${'0'.repeat(8)}|create_new`, title: 'Create new' },
          ] : undefined));
        }
        case 'ready':
          if (!action) { await say(`I can't save this yet: ${authMessage}`); return; }
          return say(this.previewFor(tenant, user, fresh));
      }
    }
    this.log.warn({ draftId }, 'advance gave up after concurrent edits');
  }

  /** API edit (POST /drafts/:id/edit): same grammar as chat; the refreshed preview is delivered to the employee's channel. */
  async apiEdit(tenant: TenantContext, user: UserContext, draftId: string, text: string): Promise<{ ok: boolean; message?: string; version?: number }> {
    const draft = await this.drafts.get(tenant.tenantId, draftId);
    if (!draft || draft.userId !== user.userId) return { ok: false, message: 'Draft not found.' };
    const data = draft.extractedData as unknown as DraftData;
    if (data.kind !== 'capture' || !['collecting', 'awaiting_confirmation'].includes(draft.state)) return { ok: false, message: 'This draft cannot be edited.' };
    const edit = parseEdit(text);
    if (!edit) return { ok: false, message: 'Unrecognised edit. Use "phone …", "email …", "note: …", "stage …" and similar.' };
    const env = this.env({ tenant, user }, new Date().toISOString());
    let failure: string | undefined;
    const row = await this.updateCapture({ tenant, user }, draft, (d) => { const r = applyEdit(d, edit, env, (l) => this.mutations.stageIdFor(tenant, l)); if (!r.ok) failure = r.message; });
    if (failure) return { ok: false, message: failure };
    await this.advance(tenant, user, draft.channel as ChannelName, draft.id, `api:${draft.id}:${row.version}`);
    return { ok: true, version: (await this.drafts.get(tenant.tenantId, draft.id))?.version };
  }

  async apiCancel(tenant: TenantContext, user: UserContext, draftId: string): Promise<'cancelled' | 'not_active' | 'not_found'> {
    return this.drafts.cancel(tenant.tenantId, draftId, user.userId);
  }

  // ── operation outcomes (CRM worker) ──────────────────────────
  successMessage(op: OperationRow, tenant: TenantContext): string {
    const res = op.result as { reference?: string; refs?: Array<{ kind: string; label: string; url?: string }> } | null;
    const lines = [`✅ Saved (ref ${res?.reference ?? OperationEffects.reference(op.id)})`];
    for (const r of res?.refs ?? []) lines.push(`• ${r.label}${r.url ? `\n  ${r.url}` : ''}`);
    void tenant;
    return lines.join('\n');
  }

  /** Tell the employee exactly what happened; never claim success before every step finished (CAP-08). */
  async notifyOutcome(outcome: ExecutionOutcome, channelHint?: string): Promise<void> {
    if (outcome.status === 'noop' || !outcome.op) return;
    const op = outcome.op;
    const live = await this.identity.getActiveUser(op.tenantId, op.userId);
    if (!live || (op.channel !== 'whatsapp' && op.channel !== 'teams')) return;
    const channel = (op.channel ?? channelHint) as ChannelName;
    const say = (text: string | ChannelReply, k: string) => this.replies.send({ tenantId: op.tenantId, userId: op.userId, channel }, typeof text === 'string' ? { text } : text, `op:${op.id}:${k}`);
    const progress = OperationJournal.describeProgress(op);
    switch (outcome.status) {
      case 'committed': await say(this.successMessage(op, live.tenant), 'done'); return;
      case 'stale': {
        if (op.draftId) {
          const rd = await this.drafts.get(op.tenantId, op.draftId);
          if (rd) await this.reopenAfterStale(live.tenant, live.user, channel, rd, op);
        }
        return;
      }
      case 'needs_repair': await say(`⚠️ Part of this could not be completed.\nSaved: ${progress.saved.join(', ') || 'nothing'}\nNeeds attention: ${progress.failed.concat(progress.pending).join(', ')}\nAn administrator has been alerted (ref ${OperationEffects.reference(op.id)}).`, 'repair'); return;
      case 'failed': await say(`I couldn't save this: ${(op.errorInfo as any)?.message ?? 'a rule blocked it'}. Nothing was saved (ref ${OperationEffects.reference(op.id)}).`, 'failed'); return;
      case 'denied': await say(`I can't save this: ${outcome.reason}`, 'denied'); return;
      case 'revoked': return; // no outbound to a revoked user (IAM-05)
    }
  }

  /** Interim "what is saved vs retrying" message after a transient failure (CAP-08). */
  async notifyProgress(tenantId: string, op: OperationRow): Promise<void> {
    if (op.channel !== 'whatsapp' && op.channel !== 'teams') return;
    const progress = OperationJournal.describeProgress(op);
    await this.replies.send({ tenantId, userId: op.userId, channel: op.channel as ChannelName }, { text: `⏳ Still saving (ref ${OperationEffects.reference(op.id)}).\nSaved so far: ${progress.saved.join(', ') || 'nothing yet'}\nRetrying: ${progress.pending.join(', ')}` }, `op:${op.id}:progress`);
  }

  private async reopenAfterStale(tenant: TenantContext, user: UserContext, channel: ChannelName, draft: DraftRow, op: OperationRow): Promise<void> {
    const data = draft.extractedData as unknown as DraftData;
    const say = this.makeSay(tenant, user, channel, `op:${op.id}:stale`);
    await this.drafts.mutate(tenant.tenantId, draft.id, () => ({ state: 'awaiting_confirmation', bumpVersion: true })).catch(() => undefined);
    if (data.kind === 'capture') {
      await this.updateCapture({ tenant, user }, (await this.drafts.get(tenant.tenantId, draft.id))!, (d) => { d.matches.signature = undefined; });
      await say('The record changed before I could save, so nothing was written. Please review the refreshed preview.');
      return this.advance(tenant, user, channel, draft.id, `op:${op.id}:stale`);
    }
    await say('The record changed before I could save, so nothing was written. Please repeat your request to get a fresh preview.');
    await this.drafts.cancel(tenant.tenantId, draft.id, user.userId);
  }
}
