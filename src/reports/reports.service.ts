import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, lt, inArray } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DbService } from '../database/db.service';
import { stageHistory } from '../database/schema';
import type { TenantContext, UserContext } from '../common/types';
import { CRM_ADAPTER, ownerKeyOf, type CrmAdapter, type CrmOpportunity } from '../crm/crm-adapter.interface';
import { canUserAccess, scopeFilterFor } from '../common/scope';
import { buildDigestModel, renderDigestText } from '../reminders/digest-builder';
import { formatMoney, formatTotals, summarizePipeline, type CurrencyTotals } from './pipeline-calculator';
import type { LlmIntent } from '../common/schemas';

export type SummaryType = NonNullable<LlmIntent['summaryType']>;

export interface ReportResult {
  /** Plain text ready to send; numbers are computed here, never by an LLM (SUM-02) */
  text: string;
  needsChoice?: Array<{ id: string; label: string }>;
}

/**
 * On-demand scoped reports (SUM-01..SUM-03). All counts and totals come from paginated
 * CRM queries under the caller's scope; the report states period, timezone, scope and
 * retrieval time, and discloses truncation or unavailable history.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DbService,
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
  ) {}

  private scopeLabel(user: UserContext): string {
    return user.role === 'salesperson' ? 'your records' : user.role === 'manager' ? 'your records and the teams you manage' : 'all records in this workspace';
  }

  private header(title: string, tenant: TenantContext, user: UserContext, now: DateTime, period?: string): string {
    return [`*${title}*`, period ? `Period: ${period}` : undefined, `Scope: ${this.scopeLabel(user)} · Timezone: ${user.timezone} · Retrieved ${now.setZone(user.timezone).toFormat('d LLL yyyy, h:mm a')}`].filter(Boolean).join('\n');
  }

  async run(type: SummaryType, tenant: TenantContext, user: UserContext, opts: { target?: string; now?: Date } = {}): Promise<ReportResult> {
    const now = DateTime.fromJSDate(opts.now ?? new Date()).setZone(user.timezone);
    switch (type) {
      case 'today_meetings': return this.todayTasks(tenant, user, now, true);
      case 'overdue_followups': return this.todayTasks(tenant, user, now, false);
      case 'company_summary': return this.company(tenant, user, now, opts.target);
      case 'my_pipeline': return this.pipeline(tenant, user, now, 'personal');
      case 'team_pipeline': return this.pipeline(tenant, user, now, 'scope');
      case 'won_this_month': return this.won(tenant, user, now);
    }
  }

  private async todayTasks(tenant: TenantContext, user: UserContext, now: DateTime, meetingsOnly: boolean): Promise<ReportResult> {
    const localDate = now.toISODate()!;
    const end = now.endOf('day').toUTC().toISO()!;
    const tasks = await this.crm.listTasks(tenant, { scope: { kind: 'owned', ownerKey: ownerKeyOf(user) }, status: 'open', dueBefore: end, maxRecords: 1000 });
    const people = new Map((await this.crm.getPeopleByIds(tenant, tasks.items.map((t) => t.personId).filter(Boolean) as string[])).filter((p) => canUserAccess(user, p)).map((p) => [p.id, p]));
    const companies = new Map((await this.crm.getCompaniesByIds(tenant, [...tasks.items.map((t) => t.companyId), ...[...people.values()].map((p) => p.companyId)].filter(Boolean) as string[])).filter((c) => canUserAccess(user, c)).map((c) => [c.id, c]));
    const model = buildDigestModel({ tasks: tasks.items, people, companies, timezone: user.timezone, localDate, urlFor: (id) => this.crm.recordUrl(tenant, 'task', id), maxItems: 50 });
    const head = this.header(meetingsOnly ? 'Who should I meet today?' : 'Your overdue follow-ups', tenant, user, now, localDate);
    if (meetingsOnly) {
      if (!model.meetings.length && !model.dueToday.length) return { text: `${head}\n\nNo matching records.` };
      return { text: `${head}\n\n${renderDigestText({ ...model, overdue: [] }, user.displayName).split('\n').slice(1).join('\n').trim()}${tasks.truncated ? '\n\n(Results truncated.)' : ''}` };
    }
    if (!model.overdue.length) return { text: `${head}\n\nNo matching records.` };
    return { text: `${head}\n\n${renderDigestText({ ...model, meetings: [], dueToday: [] }, user.displayName).split('\n').slice(1).join('\n').trim()}${tasks.truncated ? '\n\n(Results truncated.)' : ''}` };
  }

  private async company(tenant: TenantContext, user: UserContext, now: DateTime, target?: string): Promise<ReportResult> {
    if (!target) return { text: 'Which company should I summarize?' };
    const scope = scopeFilterFor(user);
    const found = (await this.crm.findCompanies(tenant, { scope, nameContains: target, limit: 10 })).filter((c) => canUserAccess(user, c));
    if (!found.length) return { text: `${this.header(`Summary: ${target}`, tenant, user, now)}\n\nNo matching records.` };
    if (found.length > 1) return { text: `Several companies match "${target}". Which one?`, needsChoice: found.map((c) => ({ id: c.id, label: c.name })) };
    const c = found[0];
    const opps = await this.crm.listOpportunities(tenant, { scope, companyId: c.id });
    const sum = summarizePipeline(opps.items.filter((o) => canUserAccess(user, o)), tenant.pipeline);
    const tasks = await this.crm.listTasks(tenant, { scope, status: 'open', maxRecords: 200 });
    const oppIds = new Set(opps.items.map((o) => o.id));
    const next = tasks.items.filter((t) => t.companyId === c.id || (t.opportunityId && oppIds.has(t.opportunityId))).slice(0, 5);
    const notes = await this.crm.listNotes(tenant, { companyId: c.id }, scope, 3);
    const lines = [this.header(`Summary: ${c.name}`, tenant, user, now), '', `Open opportunities: ${sum.openCount} · Open value: ${formatTotals(sum.openTotals)}`];
    for (const s of sum.stages.filter((x) => x.count)) lines.push(`• ${s.label}: ${s.count} (${formatTotals(s.totals)})`);
    if (next.length) lines.push('', 'Next actions:', ...next.map((t) => `• ${t.title}${t.dueDate ? ` — ${t.dueDate}` : ''}`));
    if (notes.length) lines.push('', 'Recent notes:', ...notes.map((n) => `• ${n.text.slice(0, 160)}`));
    if (!opps.items.length && !next.length && !notes.length) lines.push('', 'No matching records.');
    if (opps.truncated) lines.push('', '(Results truncated — some opportunities are not included.)');
    lines.push('', this.crm.recordUrl(tenant, 'company', c.id));
    return { text: lines.join('\n') };
  }

  private async pipeline(tenant: TenantContext, user: UserContext, now: DateTime, mode: 'personal' | 'scope'): Promise<ReportResult> {
    const scope = mode === 'personal' ? { kind: 'owned' as const, ownerKey: ownerKeyOf(user) } : scopeFilterFor(user);
    const opps = await this.crm.listOpportunities(tenant, { scope });
    const sum = summarizePipeline(opps.items.filter((o) => canUserAccess(user, o) || mode === 'personal'), tenant.pipeline);
    const title = mode === 'personal' || user.role === 'salesperson' ? 'Your pipeline' : user.role === 'manager' ? "Your team's pipeline" : 'Pipeline';
    const lines = [this.header(title, tenant, user, now, 'current (open = not archived, not won/lost)'), ''];
    lines.push(`Open opportunities: ${sum.openCount} · Open value: ${formatTotals(sum.openTotals)}`);
    for (const s of sum.stages.filter((x) => !x.terminal)) lines.push(`• ${s.label}: ${s.count}${Object.keys(s.totals).length ? ` (${formatTotals(s.totals)})` : ''}`);
    if (sum.noValueCount) lines.push(`(${sum.noValueCount} open opportunities have no amount and are not valued.)`);
    if (!sum.openCount) lines.push('', 'No matching records.');
    if (opps.truncated) lines.push('', '(Results truncated — totals are incomplete.)');
    return { text: lines.join('\n') };
  }

  /** Won/lost use the recorded stage-change date, never last-modified time (SUM-03, SYNC-03). */
  private async won(tenant: TenantContext, user: UserContext, now: DateTime): Promise<ReportResult> {
    const start = now.startOf('month'); const end = start.plus({ months: 1 });
    const period = `${start.toFormat('d LLL')} – ${end.minus({ days: 1 }).toFormat('d LLL yyyy')}`;
    const wonStages = tenant.pipeline.stages.filter((s) => s.terminalType === 'won').map((s) => s.id);
    if (!wonStages.length) return { text: `${this.header('Won this month', tenant, user, now, period)}\n\nThis workspace's pipeline has no "won" stage configured.` };
    const hist = await this.db.tenantTx(tenant.tenantId, (tx) =>
      tx.select().from(stageHistory).where(and(eq(stageHistory.tenantId, tenant.tenantId), inArray(stageHistory.toStageId, wonStages), gte(stageHistory.changedAt, start.toJSDate()), lt(stageHistory.changedAt, end.toJSDate()))),
    );
    const scope = scopeFilterFor(user);
    const current = await this.crm.listOpportunities(tenant, { scope, stageIds: wonStages });
    const inMonthIds = new Set(hist.map((h) => h.opportunityId));
    const wonOpps: CrmOpportunity[] = current.items.filter((o) => inMonthIds.has(o.id) && canUserAccess(user, o));
    const noHistory = (await this.noHistoryCount(tenant, current.items, wonStages));
    const totals: CurrencyTotals = {};
    for (const o of wonOpps) if (o.amountMicros != null && o.currency) totals[o.currency] = (totals[o.currency] ?? 0n) + BigInt(Math.trunc(o.amountMicros));
    const lines = [this.header('Won this month', tenant, user, now, period), '', `Won: ${wonOpps.length} · Value: ${formatTotals(totals)}`];
    for (const o of wonOpps.slice(0, 15)) lines.push(`• ${o.title}${o.amountMicros != null && o.currency ? ` — ${formatMoney(BigInt(o.amountMicros), o.currency)}` : ''}`);
    if (!wonOpps.length) lines.push('', 'No matching records.');
    if (noHistory) lines.push('', `Note: ${noHistory} won opportunities have no recorded stage-change date (e.g. imported records), so they are not counted.`);
    if (current.truncated) lines.push('', '(Results truncated — totals are incomplete.)');
    return { text: lines.join('\n') };
  }

  private async noHistoryCount(tenant: TenantContext, opps: CrmOpportunity[], wonStages: string[]): Promise<number> {
    if (!opps.length) return 0;
    const rows = await this.db.tenantTx(tenant.tenantId, (tx) =>
      tx.select({ id: stageHistory.opportunityId }).from(stageHistory).where(and(eq(stageHistory.tenantId, tenant.tenantId), inArray(stageHistory.toStageId, wonStages), inArray(stageHistory.opportunityId, opps.map((o) => o.id)))),
    );
    const have = new Set(rows.map((r) => r.id));
    return opps.filter((o) => !have.has(o.id)).length;
  }
}
