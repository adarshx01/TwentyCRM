import { DateTime } from 'luxon';
import type { ChannelReply } from '../channels/channel.types';
import { encodeButton } from '../channels/channel.types';
import type { CaptureLeadAction } from '../common/schemas';
import type { CaptureData, MutationData } from './draft.types';
import { formatTaskWhen, opportunityTitle } from './capture-logic';
import type { DraftRow } from './draft.service';

const SRC: Record<string, string> = { card: 'card', voice: 'voice', text: 'text', user: 'your edit', email: 'email' };
const src = (d: CaptureData, k: string) => (d.fieldSources[k] ? ` _(${SRC[d.fieldSources[k]]})_` : '');

export function confirmButtons(draft: Pick<DraftRow, 'id' | 'version' | 'contentHash'>): ChannelReply['buttons'] {
  const hash = (draft.contentHash ?? '').slice(0, 8);
  const mk = (action: 'confirm' | 'edit' | 'cancel') => encodeButton({ kind: 'draft', draftId: draft.id, version: draft.version, hash, action });
  return [
    { id: mk('confirm'), title: 'Confirm', style: 'primary' },
    { id: mk('edit'), title: 'Edit' },
    { id: mk('cancel'), title: 'Cancel', style: 'danger' },
  ];
}

const footer = (draft: DraftRow) => {
  const mins = draft.expiresAt ? Math.max(1, Math.round((draft.expiresAt.getTime() - Date.now()) / 60000)) : 30;
  return `\n⚠️ This draft has NOT been saved yet. Reply Confirm, Edit or Cancel.\n_Draft ${draft.id.slice(0, 8)} · v${draft.version} · expires in ~${mins} min_`;
};

export function renderCapturePreview(draft: DraftRow, d: CaptureData, action: CaptureLeadAction, ownerName: string, stageLabel: (id: string) => string): ChannelReply {
  const L: string[] = ['📝 *Draft lead — please review*', ''];
  const existingPerson = action.existing?.personId ? d.matches.people.find((m) => m.id === action.existing!.personId) : undefined;

  if (existingPerson) {
    L.push(`*Contact:* updating existing — ${existingPerson.label}${existingPerson.email ? ` (${existingPerson.email})` : ''}`);
    const f = action.personFill;
    if (f?.email) L.push(`   • email: ${existingPerson.existing.email ? `${existingPerson.existing.email} → ` : '(blank) → '}${f.email}`);
    if (f?.phoneRaw) L.push(`   • phone: ${existingPerson.existing.phone ? `${existingPerson.existing.phone} → ` : '(blank) → '}${f.phoneE164 ?? f.phoneRaw}`);
    if (f?.title) L.push(`   • title: ${existingPerson.existing.title ? `${existingPerson.existing.title} → ` : '(blank) → '}${f.title}`);
    const kept = [
      d.person?.email && existingPerson.existing.email && d.person.email !== existingPerson.existing.email && !f?.email ? `email (${existingPerson.existing.email})` : '',
      d.person?.phoneRaw && existingPerson.existing.phone && !f?.phoneRaw && (d.person.phoneE164 ?? d.person.phoneRaw) !== existingPerson.existing.phone ? `phone (${existingPerson.existing.phone})` : '',
    ].filter(Boolean);
    if (kept.length) L.push(`   • kept existing ${kept.join(', ')} — say "replace email" / "replace phone" to overwrite`);
  } else if (action.person) {
    const p = action.person;
    L.push(`*Contact:* ${p.name ?? '—'}${src(d, 'name')}`);
    if (p.title) L.push(`   Title: ${p.title}${src(d, 'title')}`);
    if (p.phoneRaw) L.push(`   Phone: ${p.phoneE164 ?? p.phoneRaw}${p.phoneE164 && p.phoneRaw !== p.phoneE164 ? ` (as written: ${p.phoneRaw})` : ''}${src(d, 'phone')}`);
    if (p.email) L.push(`   Email: ${p.email}${src(d, 'email')}`);
  }
  if (action.existing?.companyId) L.push(`*Company:* existing record selected`);
  else if (action.company) {
    L.push(`*Company:* ${action.company.name}${src(d, 'company')}`);
    if (action.company.website) L.push(`   Website: ${action.company.website}`);
    if (action.company.address) L.push(`   Address: ${action.company.address}`);
  }
  if (action.existing?.opportunityId) L.push(`*Opportunity:* adding to the existing opportunity you selected`);
  else if (action.opportunity) {
    L.push(`*Opportunity:* ${action.opportunity.title} · Stage: ${stageLabel(action.opportunity.stageId ?? d.opportunity.stageId)} · Owner: ${ownerName}`);
    if (action.opportunity.interest) L.push(`   Interest: ${action.opportunity.interest}${src(d, 'interest')}`);
    if (action.opportunity.amount != null) L.push(`   Amount: ${action.opportunity.amount} ${action.opportunity.currency ?? ''}`);
  }
  for (const n of d.notes) L.push(`*Note (${SRC[n.source]}):* ${n.text.length > 300 ? `${n.text.slice(0, 297)}…` : n.text}`);
  d.tasks.forEach((t, i) => L.push(`*${t.type === 'meeting' ? 'Meeting' : 'Task'} ${i + 1}:* ${t.title} — ${formatTaskWhen(t)}${t.location ? ` @ ${t.location}` : ''}${t.expression ? ` _(you said: "${t.expression}")_` : ''}`));
  if (!d.tasks.length) L.push('*Next action:* none scheduled — say "task: call on Friday" to add one.');
  if (d.matches.hiddenCount) L.push('', 'ℹ️ A possible match exists outside your access; no details are shown.');
  if (d.uncertain.length) { L.push('', '⚠️ *Please check:*'); for (const u of d.uncertain) L.push(`   • ${u.field}: ${u.reason}${u.candidates ? ` (${u.candidates.join(' vs ')})` : ''}`); }
  return { text: L.join('\n') + footer(draft), buttons: confirmButtons(draft) };
}

export function renderMutationPreview(draft: DraftRow, m: MutationData): ChannelReply {
  const L = ['📝 *Please review this change*', '', ...m.summaryLines];
  if (m.warnings.length) L.push('', ...m.warnings.map((w) => `⚠️ ${w}`));
  return { text: L.join('\n') + footer(draft), buttons: confirmButtons(draft) };
}

export function renderClarification(question: string, options?: Array<{ label: string }>, buttons?: ChannelReply['buttons']): ChannelReply {
  const lines = [question];
  options?.forEach((o, i) => lines.push(`${i + 1}. ${o.label}`));
  if (options) lines.push('', 'Reply with a number.');
  return { text: lines.join('\n'), buttons };
}

export const fmtLocal = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).toFormat('ccc d LLL yyyy, h:mm a');
export { opportunityTitle };
