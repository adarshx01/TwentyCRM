import { DateTime } from 'luxon';
import { CaptureLeadActionSchema, type CaptureLeadAction, type LlmIntent } from '../common/schemas';
import { normalizeEmail, normalizePhone } from '../common/utils/phone.util';
import { parseTimeExpression, resolveRelativeDate } from '../common/utils/date.util';
import type { NormalizedCard } from '../extraction/extraction.service';
import type { CaptureData, Clarification, Source, TaskDraft } from './draft.types';

export interface CaptureEnv {
  timezone: string;
  /** Message timestamp (ISO) — relative dates resolve against this (CAP-05) */
  nowIso: string;
  defaultCountry?: string;
  defaultCurrency: string;
  stageLabel: (stageId: string) => string;
}

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function setUncertain(d: CaptureData, field: string, reason: string, candidates?: string[]) {
  const i = d.uncertain.findIndex((u) => u.field === field && u.reason === reason);
  if (i >= 0) d.uncertain[i] = { field, reason, candidates };
  else d.uncertain.push({ field, reason, candidates });
}

/**
 * Set a value honouring source precedence:
 *  - user edits always win
 *  - card details are never silently replaced by voice/text details (CAP-04): a conflict is flagged
 */
function setField(d: CaptureData, key: string, current: string | undefined, next: string | undefined, source: Source, assign: (v: string) => void): void {
  if (!next) return;
  if (!current) { assign(next); d.fieldSources[key] = source; return; }
  if (norm(current) === norm(next)) return;
  const prior = d.fieldSources[key];
  if (source === 'user') { assign(next); d.fieldSources[key] = 'user'; d.uncertain = d.uncertain.filter((u) => u.field !== key); return; }
  if (prior === 'user') return;
  setUncertain(d, key, `conflicting values from ${prior ?? 'earlier'} and ${source}`, [current, next]);
  if (prior !== 'card' && source === 'card') { assign(next); d.fieldSources[key] = 'card'; }
}

function setPhone(d: CaptureData, raw: string, source: Source, env: CaptureEnv, printed: boolean) {
  const trimmed = raw.trim();
  const hasCountry = printed || trimmed.startsWith('+') || trimmed.startsWith('00');
  const r = normalizePhone(trimmed.startsWith('00') ? `+${trimmed.slice(2)}` : trimmed, hasCountry ? undefined : env.defaultCountry);
  const prior = d.person?.phoneRaw;
  d.person ??= {};
  if (prior && norm(prior) !== norm(trimmed) && d.fieldSources.phone === 'user' && source !== 'user') return;
  if (prior && d.person.phoneE164 && r.e164 && d.person.phoneE164 !== r.e164 && source !== 'user') {
    // Keep the earlier (card) number and ask the user; never silently replace it (CAP-04).
    setUncertain(d, 'phone', `conflicting numbers from ${d.fieldSources.phone ?? 'earlier'} and ${source}`, [d.person.phoneE164, r.e164]);
    return;
  }
  d.person.phoneRaw = trimmed;
  d.person.phoneE164 = r.e164;
  d.person.phoneCountryAssumed = !hasCountry && !!r.e164;
  d.fieldSources.phone = source;
  d.uncertain = d.uncertain.filter((u) => !(u.field === 'phone' && /country code|assumed|conflict/.test(u.reason)));
  if (!hasCountry) setUncertain(d, 'phone', r.e164 ? `country code not given; assumed ${env.defaultCountry} — please check` : 'country code not given; saved exactly as written');
}

export function applyCard(d: CaptureData, card: NormalizedCard, env: CaptureEnv): void {
  d.person ??= {};
  setField(d, 'name', d.person.name, card.name, 'card', (v) => (d.person!.name = v));
  setField(d, 'title', d.person.title, card.title, 'card', (v) => (d.person!.title = v));
  if (card.email) setField(d, 'email', d.person.email, card.email, 'card', (v) => (d.person!.email = v));
  if (card.phones[0]) {
    const p = card.phones[0];
    d.person.phoneRaw = p.raw; d.person.phoneE164 = p.e164; d.person.phoneCountryAssumed = p.countryAssumed; d.fieldSources.phone = 'card';
    if (!p.raw.trim().startsWith('+') && !p.raw.trim().startsWith('00')) setUncertain(d, 'phone', p.e164 ? `country code not printed on the card; assumed ${env.defaultCountry} — please check` : 'country code not printed on the card; saved exactly as written');
  }
  if (card.phones.length > 1) d.notes.push({ text: `Additional numbers on card: ${card.phones.slice(1).map((p) => p.raw).join(', ')}`, type: 'observation', source: 'card' });
  if (card.company || card.website || card.address) {
    d.company ??= {};
    setField(d, 'company', d.company.name, card.company, 'card', (v) => (d.company!.name = v));
    setField(d, 'website', d.company.website, card.website, 'card', (v) => (d.company!.website = v));
    setField(d, 'address', d.company.address, card.address, 'card', (v) => (d.company!.address = v));
  }
  for (const u of card.uncertain) setUncertain(d, u.field, u.reason);
  d.pending.card = Math.max(0, d.pending.card - 1);
}

let clarSeq = 0;
const clar = (c: Omit<Clarification, 'id'>): Clarification => ({ id: `c${++clarSeq}`, ...c });

/** Resolve one model-proposed task into a concrete draft or a clarification (CAP-05). */
function resolveTask(d: CaptureData, t: { title: string; type: TaskDraft['type']; dateExpression?: string; timeExpression?: string; location?: string }, env: CaptureEnv, fallbackDate?: string, fallbackTime?: string): void {
  const expr = [t.dateExpression, t.timeExpression].filter(Boolean).join(' ') || [fallbackDate, fallbackTime].filter(Boolean).join(' ');
  const res = t.dateExpression || fallbackDate ? resolveRelativeDate(t.dateExpression ?? fallbackDate!, env.timezone, env.nowIso) : { date: null as string | null, time: null as string | null, ambiguous: true, reason: 'no date given' };
  const time = parseTimeExpression(t.timeExpression) ?? res.time ?? parseTimeExpression(fallbackTime);
  const draft: TaskDraft = { title: t.title, type: t.type, timezone: env.timezone, location: t.location, expression: expr || undefined };
  const idx = d.tasks.length;
  if (res.date) draft.dueDate = res.date;
  if (time) draft.dueTime = time;
  d.tasks.push(draft);
  if (!res.date) {
    d.clarifications.push(clar({ kind: 'date', taskIndex: idx, question: t.type === 'meeting' ? `On which date is the meeting "${t.title}"? (${res.reason ?? 'no date given'})` : `When should I schedule "${t.title}"? Give a date, or say "no date" to skip the task. (${res.reason ?? 'no date given'})` }));
  } else if (t.type === 'meeting' && !time) {
    d.clarifications.push(clar({ kind: 'meeting_time', taskIndex: idx, question: `What time is the meeting on ${res.date}? A meeting needs an explicit time; otherwise I can save it as a date-only follow-up.` }));
  }
}

/**
 * Merge model-structured intent from a text message or voice transcript. The raw text
 * is stored verbatim as the note (never the model's paraphrase).
 */
export function applyIntent(d: CaptureData, intent: LlmIntent, rawText: string, source: Source, env: CaptureEnv): void {
  const p = intent.person;
  if (p) {
    d.person ??= {};
    setField(d, 'name', d.person.name, p.name?.trim(), source, (v) => (d.person!.name = v));
    setField(d, 'title', d.person.title, p.title?.trim(), source, (v) => (d.person!.title = v));
    if (p.email) {
      const e = normalizeEmail(p.email);
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) setField(d, 'email', d.person.email, e, source, (v) => (d.person!.email = v));
      else setUncertain(d, 'email', 'does not look like a valid email address');
    }
    if (p.phone) setPhone(d, p.phone, source, env, false);
    const comp = p.companyName?.trim();
    if (comp) { d.company ??= {}; setField(d, 'company', d.company.name, comp, source, (v) => (d.company!.name = v)); }
    if (p.website) { d.company ??= {}; setField(d, 'website', d.company.website, p.website, source, (v) => (d.company!.website = v)); }
    if (p.address) { d.company ??= {}; setField(d, 'address', d.company.address, p.address, source, (v) => (d.company!.address = v)); }
  }
  if (intent.companyName) { d.company ??= {}; setField(d, 'company', d.company.name, intent.companyName.trim(), source, (v) => (d.company!.name = v)); }
  if (intent.interest) setField(d, 'interest', d.opportunity.interest, intent.interest.trim(), source, (v) => (d.opportunity.interest = v));
  if (intent.opportunityTitle) setField(d, 'opportunityTitle', d.opportunity.title, intent.opportunityTitle.trim(), source, (v) => (d.opportunity.title = v));
  if (intent.amount != null) {
    d.opportunity.amount = intent.amount;
    d.opportunity.currency = intent.currency ?? env.defaultCurrency;
    d.fieldSources.amount = source;
    if (!intent.currency) setUncertain(d, 'currency', `no currency stated; using ${env.defaultCurrency}`);
  }
  const text = rawText.trim();
  if (text) {
    const type = source === 'voice' ? 'transcript' : 'observation';
    if (!d.notes.some((n) => n.text === text)) d.notes.push({ text: text.slice(0, 4000), type, source });
  }
  for (const t of intent.tasks ?? []) resolveTask(d, t, env, intent.dateExpression, intent.timeExpression);
  d.awaitingContext = false;
}

/** Plain context text with no usable structure: record as a note (CAP-02). */
export function applyContextText(d: CaptureData, text: string, source: Source): void {
  const t = text.trim();
  if (t && !d.notes.some((n) => n.text === t)) d.notes.push({ text: t.slice(0, 4000), type: source === 'voice' ? 'transcript' : 'observation', source });
  d.awaitingContext = false;
}

// ── user edits (deterministic grammar) ─────────────────────────
export type EditCommand =
  | { op: 'set'; field: 'name' | 'title' | 'email' | 'phone' | 'company' | 'website' | 'address' | 'interest' | 'stage' | 'amount' | 'opportunity'; value: string }
  | { op: 'note'; value: string }
  | { op: 'remove_task'; index?: number }
  | { op: 'replace'; field: 'email' | 'phone' | 'title' }
  | { op: 'skip_context' }
  | { op: 'task'; value: string };

const FIELD_ALIASES: Record<string, Extract<EditCommand, { op: 'set' }>['field']> = {
  name: 'name', contact: 'name', person: 'name', title: 'title', role: 'title', designation: 'title', email: 'email', 'e-mail': 'email', phone: 'phone', mobile: 'phone', number: 'phone',
  company: 'company', business: 'company', website: 'website', site: 'website', address: 'address', interest: 'interest', stage: 'stage', amount: 'amount', value: 'amount', opportunity: 'opportunity', deal: 'opportunity',
};

export function parseEdit(text: string): EditCommand | null {
  const t = text.trim();
  if (/^(continue without (a )?note|no note|skip( note)?)\.?$/i.test(t)) return { op: 'skip_context' };
  let m = /^replace\s+(email|phone|title)\.?$/i.exec(t);
  if (m) return { op: 'replace', field: m[1].toLowerCase() as 'email' | 'phone' | 'title' };
  m = /^remove\s+task(?:\s+(\d+))?\.?$/i.exec(t);
  if (m) return { op: 'remove_task', index: m[1] ? Number(m[1]) - 1 : undefined };
  m = /^(?:add\s+)?note\s*[:-]\s*([\s\S]+)$/i.exec(t);
  if (m) return { op: 'note', value: m[1].trim() };
  m = /^(?:add\s+)?(?:task|follow[- ]?up|meeting)\s*[:-]\s*([\s\S]+)$/i.exec(t);
  if (m) return { op: 'task', value: t };
  m = /^(?:set\s+|change\s+|correct\s+|fix\s+)?(name|contact|person|title|role|designation|email|e-mail|phone|mobile|number|company|business|website|site|address|interest|stage|amount|value|opportunity|deal)\s*(?:is|to|=|:)?\s+([\s\S]+)$/i.exec(t);
  if (m && FIELD_ALIASES[m[1].toLowerCase()]) return { op: 'set', field: FIELD_ALIASES[m[1].toLowerCase()], value: m[2].trim().replace(/^["']|["']$/g, '') };
  return null;
}

export function applyEdit(d: CaptureData, edit: EditCommand, env: CaptureEnv, stageIdFor: (label: string) => string | undefined): { ok: boolean; message?: string } {
  switch (edit.op) {
    case 'skip_context': d.contextSkipped = true; d.awaitingContext = false; return { ok: true };
    case 'replace': if (!d.overwrite.includes(edit.field)) d.overwrite.push(edit.field); return { ok: true };
    case 'note': d.notes.push({ text: edit.value.slice(0, 4000), type: 'observation', source: 'user' }); d.awaitingContext = false; return { ok: true };
    case 'remove_task': {
      const i = edit.index ?? d.tasks.length - 1;
      if (i < 0 || i >= d.tasks.length) return { ok: false, message: 'There is no such task in this draft.' };
      d.tasks.splice(i, 1);
      d.clarifications = d.clarifications.filter((c) => c.taskIndex === undefined).concat(d.clarifications.filter((c) => c.taskIndex !== undefined && c.taskIndex !== i).map((c) => ({ ...c, taskIndex: c.taskIndex! > i ? c.taskIndex! - 1 : c.taskIndex })));
      return { ok: true };
    }
    case 'task': {
      const body = edit.value.replace(/^(?:add\s+)?(task|follow[- ]?up|meeting)\s*[:-]\s*/i, '');
      const type = /meeting/i.test(edit.value.split(/[:-]/)[0]) ? 'meeting' : 'follow_up';
      resolveTask(d, { title: body.slice(0, 200), type, dateExpression: body, timeExpression: body }, env);
      return { ok: true };
    }
    case 'set': {
      d.person ??= {};
      const v = edit.value;
      switch (edit.field) {
        case 'name': d.person.name = v; d.fieldSources.name = 'user'; break;
        case 'title': d.person.title = v; d.fieldSources.title = 'user'; break;
        case 'email': {
          const e = normalizeEmail(v);
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { ok: false, message: `"${v}" doesn't look like a valid email address.` };
          d.person.email = e; d.fieldSources.email = 'user'; d.uncertain = d.uncertain.filter((u) => u.field !== 'email'); break;
        }
        case 'phone': setPhone(d, v, 'user', env, false); break;
        case 'company': d.company ??= {}; d.company.name = v; d.fieldSources.company = 'user'; d.uncertain = d.uncertain.filter((u) => u.field !== 'company'); break;
        case 'website': d.company ??= {}; d.company.website = v; d.fieldSources.website = 'user'; break;
        case 'address': d.company ??= {}; d.company.address = v; d.fieldSources.address = 'user'; break;
        case 'interest': d.opportunity.interest = v; d.fieldSources.interest = 'user'; break;
        case 'opportunity': d.opportunity.title = v; d.fieldSources.opportunityTitle = 'user'; break;
        case 'stage': {
          const id = stageIdFor(v);
          if (!id) return { ok: false, message: `"${v}" is not a stage in your pipeline.` };
          d.opportunity.stageId = id; break;
        }
        case 'amount': {
          const m = /^([\d,.]+)\s*([A-Za-z]{3})?$/.exec(v.replace(/\s+/g, ' '));
          if (!m) return { ok: false, message: 'Please give the amount like "50000 INR".' };
          d.opportunity.amount = Number(m[1].replace(/,/g, ''));
          d.opportunity.currency = (m[2] ?? env.defaultCurrency).toUpperCase();
          d.fieldSources.amount = 'user';
          if (!m[2]) setUncertain(d, 'currency', `no currency stated; using ${env.defaultCurrency}`);
          break;
        }
      }
      d.matches.signature = undefined; // identity fields changed: re-check duplicates
      return { ok: true };
    }
  }
}

/** Answer the first open clarification from free text or a numbered option. */
export function answerClarification(d: CaptureData, text: string): { ok: boolean; message?: string } {
  const c = d.clarifications[0];
  if (!c) return { ok: false };
  const t = text.trim();
  if (c.options) {
    const n = /^\d+$/.test(t) ? Number(t) : NaN;
    const byLabel = c.options.find((o) => norm(o.label) === norm(t) || norm(t) === o.id);
    const opt = Number.isFinite(n) ? c.options[n - 1] : byLabel;
    if (!opt) return { ok: false, message: `Please reply with a number from 1 to ${c.options.length}.` };
    if (c.kind === 'match_person') d.decisions.person = opt.id;
    if (c.kind === 'match_company') d.decisions.company = opt.id;
    if (c.kind === 'opportunity_target') d.decisions.opportunity = opt.id;
    d.clarifications.shift();
    return { ok: true };
  }
  if (c.kind === 'date' || c.kind === 'meeting_time') return { ok: false }; // handled by caller with env
  return { ok: false };
}

export function answerTaskClarification(d: CaptureData, text: string, env: CaptureEnv): { ok: boolean; message?: string } {
  const c = d.clarifications[0];
  if (!c || c.taskIndex === undefined) return { ok: false };
  const task = d.tasks[c.taskIndex];
  if (!task) { d.clarifications.shift(); return { ok: true }; }
  if (c.kind === 'date') {
    if (/^(no date|skip|none|no|cancel task|drop( it)?)\.?$/i.test(text.trim())) {
      d.tasks.splice(c.taskIndex, 1);
      d.clarifications.shift();
      d.clarifications = d.clarifications.filter((x) => x.taskIndex !== c.taskIndex).map((x) => ({ ...x, taskIndex: x.taskIndex !== undefined && x.taskIndex > c.taskIndex! ? x.taskIndex - 1 : x.taskIndex }));
      return { ok: true };
    }
    const res = resolveRelativeDate(text, env.timezone, env.nowIso);
    if (!res.date) return { ok: false, message: `I still can't pin that down (${res.reason}). Please give a date like "29 September" or "next Tuesday".` };
    task.dueDate = res.date;
    task.dueTime = parseTimeExpression(text) ?? task.dueTime;
    d.clarifications.shift();
    if (task.type === 'meeting' && !task.dueTime) d.clarifications.unshift(clar({ kind: 'meeting_time', taskIndex: c.taskIndex, question: `What time is the meeting on ${res.date}?` }));
    return { ok: true };
  }
  if (c.kind === 'meeting_time') {
    if (/^(date only|no time|follow[- ]?up|skip)\.?$/i.test(text.trim())) { task.type = 'follow_up'; d.clarifications.shift(); return { ok: true }; }
    const time = parseTimeExpression(text);
    if (!time) return { ok: false, message: 'Please give a time like "11 AM" or "15:30" — or say "date only" to save a follow-up without a time.' };
    task.dueTime = time;
    d.clarifications.shift();
    return { ok: true };
  }
  return { ok: false };
}

export type NextStep =
  | { kind: 'processing' }
  | { kind: 'need_context' }
  | { kind: 'clarify'; clarification: Clarification }
  | { kind: 'ready' };

export function nextStep(d: CaptureData): NextStep {
  if (d.pending.card > 0 || d.pending.voice > 0) return { kind: 'processing' };
  if (d.awaitingContext && !d.contextSkipped && d.notes.filter((n) => n.source !== 'card').length === 0 && d.tasks.length === 0) return { kind: 'need_context' };
  if (!d.person?.name && !d.company?.name && !d.decisions.person?.length && !d.clarifications.some((c) => c.kind === 'person_unclear')) {
    d.clarifications.push(clar({ kind: 'person_unclear', question: 'Who is this lead? Send a name or a company so I know which record to create.' }));
  }
  if (d.clarifications.length) return { kind: 'clarify', clarification: d.clarifications[0] };
  return { kind: 'ready' };
}

export function opportunityTitle(d: CaptureData): string {
  if (d.opportunity.title) return d.opportunity.title;
  const n = d.person?.name; const c = d.company?.name;
  return n && c ? `${n} — ${c}` : n ?? c ?? 'New enquiry';
}

/** Build the executable action from the draft (IDs only from server-validated decisions). */
export function buildCaptureAction(d: CaptureData, ownerUserId?: string): CaptureLeadAction {
  const existingPerson = d.decisions.person && d.decisions.person !== 'new' ? d.decisions.person : undefined;
  const existingCompany = d.decisions.company && d.decisions.company !== 'new' ? d.decisions.company : undefined;
  const existingOpp = d.decisions.opportunity && d.decisions.opportunity !== 'new' ? d.decisions.opportunity : undefined;
  const match = existingPerson ? d.matches.people.find((m) => m.id === existingPerson) : undefined;

  const person = !existingPerson && (d.person?.name || d.person?.email || d.person?.phoneRaw)
    ? { name: d.person?.name, title: d.person?.title, email: d.person?.email, phoneRaw: d.person?.phoneRaw, phoneE164: d.person?.phoneE164 ?? undefined, companyName: d.company?.name }
    : undefined;

  // Existing person: fill only blanks; overwrite only on explicit request (CAP-06).
  const fill: Record<string, string> = {};
  if (match && d.person) {
    if (d.person.email && (!match.existing.email || d.overwrite.includes('email')) && d.person.email !== match.existing.email) fill.email = d.person.email;
    if (d.person.phoneRaw && (!match.existing.phone || d.overwrite.includes('phone')) && (d.person.phoneE164 ?? d.person.phoneRaw) !== match.existing.phone) {
      fill.phoneRaw = d.person.phoneRaw; if (d.person.phoneE164) fill.phoneE164 = d.person.phoneE164;
    }
    if (d.person.title && (!match.existing.title || d.overwrite.includes('title')) && d.person.title !== match.existing.title) fill.title = d.person.title;
    if (existingCompany && !match.existing.companyId) fill.companyId = existingCompany;
  }

  const hasCompany = !existingCompany && d.company?.name;
  const action = {
    type: 'capture_lead' as const,
    person,
    company: hasCompany ? { name: d.company!.name!, website: d.company?.website?.match(/^https?:\/\//) ? d.company.website : undefined, domain: d.company?.website, address: d.company?.address } : undefined,
    opportunity: existingOpp ? undefined : { title: opportunityTitle(d), stageId: d.opportunity.stageId, interest: d.opportunity.interest, amount: d.opportunity.amount, currency: d.opportunity.currency },
    notes: d.notes.map((n) => ({ text: n.text, type: (n.type === 'transcript' ? 'transcript' : n.type === 'meeting_note' ? 'meeting_note' : 'observation') as 'observation' | 'meeting_note' | 'transcript', eventTime: undefined })),
    tasks: d.tasks.map((t) => ({ title: t.title, type: t.type, dueDate: t.dueDate, dueTime: t.dueTime, timezone: t.timezone, location: t.location })),
    existing: existingPerson || existingCompany || existingOpp ? { personId: existingPerson, companyId: existingCompany, opportunityId: existingOpp } : undefined,
    personFill: Object.keys(fill).length ? fill : undefined,
    ownerUserId,
    sourceAttribution: d.fieldSources,
  };
  return CaptureLeadActionSchema.parse(JSON.parse(JSON.stringify(action)));
}

export function formatTaskWhen(t: TaskDraft): string {
  if (!t.dueDate) return 'no date';
  const dt = DateTime.fromISO(t.dueTime ? `${t.dueDate}T${t.dueTime}` : t.dueDate, { zone: t.timezone });
  return t.dueTime ? `${dt.toFormat('ccc d LLL yyyy, h:mm a')} ${t.timezone}` : `${dt.toFormat('ccc d LLL yyyy')} (date only, ${t.timezone})`;
}
