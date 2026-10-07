import { DateTime } from 'luxon';
import type { CrmCompany, CrmPerson, CrmTask } from '../crm/crm-adapter.interface';
import type { ChannelReply } from '../channels/channel.types';

export interface DigestItem {
  taskId: string;
  title: string;
  kind: string;
  /** Present only when the task has an explicit time — never invented (REM-02) */
  timeLabel?: string;
  contact?: string;
  company?: string;
  dueDate: string;
  url: string;
  location?: string;
}

export interface DigestModel {
  localDate: string;
  timezone: string;
  meetings: DigestItem[];
  dueToday: DigestItem[];
  overdue: DigestItem[];
  hidden: number;
}

export interface BuildInput {
  tasks: CrmTask[];
  people: Map<string, CrmPerson>;
  companies: Map<string, CrmCompany>;
  timezone: string;
  localDate: string;
  urlFor: (taskId: string) => string;
  maxItems?: number;
}

export function localDateOf(t: CrmTask, tz: string): string | undefined {
  if (t.dueDate) return t.dueDate;
  if (!t.dueAt) return undefined;
  return DateTime.fromISO(t.dueAt, { zone: 'utc' }).setZone(tz).toISODate() ?? undefined;
}

/**
 * Deterministic digest content (REM-02): today's meetings in time order, due-today
 * follow-ups, and overdue open tasks in a separate section. Completed, cancelled and
 * archived tasks are excluded. Date-only tasks never show a time.
 */
export function buildDigestModel(input: BuildInput): DigestModel {
  const { tz, localDate } = { tz: input.timezone, localDate: input.localDate };
  const toItem = (t: CrmTask, dueDate: string): DigestItem => {
    const person = t.personId ? input.people.get(t.personId) : undefined;
    const companyId = t.companyId ?? person?.companyId;
    const company = companyId ? input.companies.get(companyId) : undefined;
    return {
      taskId: t.id, title: t.title, kind: t.kind, dueDate,
      timeLabel: t.hasTime && t.dueAt ? DateTime.fromISO(t.dueAt, { zone: 'utc' }).setZone(tz).toFormat('h:mm a') : undefined,
      contact: person?.name, company: company?.name, url: input.urlFor(t.id), location: t.location,
    };
  };

  const meetings: Array<[CrmTask, DigestItem]> = [];
  const dueToday: Array<[CrmTask, DigestItem]> = [];
  const overdue: DigestItem[] = [];

  for (const t of input.tasks) {
    if (t.status !== 'open' || t.archived) continue;
    const d = localDateOf(t, tz);
    if (!d) continue;
    if (d < localDate) overdue.push(toItem(t, d));
    else if (d === localDate) {
      (t.kind === 'meeting' && t.hasTime ? meetings : dueToday).push([t, toItem(t, d)]);
    }
  }
  const byTime = (a: [CrmTask, DigestItem], b: [CrmTask, DigestItem]) => (a[0].dueAt ?? '').localeCompare(b[0].dueAt ?? '');
  meetings.sort(byTime);
  // Timed items first (in time order), then date-only items.
  dueToday.sort((a, b) => (a[0].hasTime === b[0].hasTime ? byTime(a, b) : a[0].hasTime ? -1 : 1));
  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const max = input.maxItems ?? 20;
  const all = { meetings: meetings.map((x) => x[1]), dueToday: dueToday.map((x) => x[1]), overdue };
  const total = all.meetings.length + all.dueToday.length + all.overdue.length;
  let budget = max;
  const take = <T,>(xs: T[]) => { const out = xs.slice(0, Math.max(0, budget)); budget -= out.length; return out; };
  const m = take(all.meetings); const d = take(all.dueToday); const o = take(all.overdue);
  return { localDate, timezone: tz, meetings: m, dueToday: d, overdue: o, hidden: total - (m.length + d.length + o.length) };
}

export const isEmptyDigest = (m: DigestModel) => m.meetings.length + m.dueToday.length + m.overdue.length === 0;

const who = (i: DigestItem) => [i.contact, i.company ? `(${i.company})` : ''].filter(Boolean).join(' ');

function line(i: DigestItem, withDue = false): string {
  const desc = [who(i), i.title].filter(Boolean).join(': ');
  const head = i.timeLabel ? `${i.timeLabel} — ${desc}` : `• ${desc}`;
  const due = withDue ? ` (due ${DateTime.fromISO(i.dueDate).toFormat('d LLL')})` : '';
  const loc = i.location ? ` @ ${i.location}` : '';
  return `${head}${loc}${due}\n  ${i.url}`;
}

export function renderDigestText(m: DigestModel, name: string): string {
  const date = DateTime.fromISO(m.localDate).toFormat('cccc, d LLLL');
  const out = [`Good morning ${name}. Your tasks for ${date} (${m.timezone}):`];
  if (m.meetings.length) out.push('', 'Meetings today', ...m.meetings.map((i) => line(i)));
  if (m.dueToday.length) out.push('', 'Due today', ...m.dueToday.map((i) => line(i)));
  if (m.overdue.length) out.push('', 'Overdue', ...m.overdue.map((i) => line(i, true)));
  if (m.hidden > 0) out.push('', `…and ${m.hidden} more. Ask me "show my overdue follow-ups" for the rest.`);
  return out.join('\n');
}

export function renderDigestCard(m: DigestModel, name: string): ChannelReply {
  const section = (title: string, items: DigestItem[], withDue = false) =>
    items.length
      ? [
          { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', spacing: 'Medium' },
          ...items.map((i) => ({
            type: 'TextBlock', wrap: true, text: `${i.timeLabel ? `**${i.timeLabel}** ` : ''}${who(i) ? `${who(i)}: ` : ''}${i.title}${withDue ? ` _(due ${DateTime.fromISO(i.dueDate).toFormat('d LLL')})_` : ''} [open](${i.url})`,
          })),
        ]
      : [];
  const card = {
    type: 'AdaptiveCard', version: '1.4', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [
      { type: 'TextBlock', text: `Good morning ${name}`, weight: 'Bolder', size: 'Large' },
      { type: 'TextBlock', text: `${DateTime.fromISO(m.localDate).toFormat('cccc, d LLLL')} · ${m.timezone}`, isSubtle: true },
      ...section('Meetings today', m.meetings), ...section('Due today', m.dueToday), ...section('Overdue', m.overdue, true),
      ...(m.hidden > 0 ? [{ type: 'TextBlock', text: `…and ${m.hidden} more.`, isSubtle: true }] : []),
    ],
  };
  return { text: renderDigestText(m, name), card };
}
