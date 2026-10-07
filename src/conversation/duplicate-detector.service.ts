import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext, UserContext } from '../common/types';
import { CRM_ADAPTER, type CrmAdapter, type CrmPerson } from '../crm/crm-adapter.interface';
import { canUserAccess, scopeFilterFor } from '../common/scope';
import type { CaptureData, Clarification, MatchSummary } from './draft.types';

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let seq = 0;

/**
 * Duplicate detection within the caller's permitted records (CAP-06).
 * Searches use normalized email/phone; name + company is only a "possible match".
 * Inaccessible matches are counted but never described (Section 4). Nothing is merged
 * automatically: the user must choose "update existing" or "create new".
 */
@Injectable()
export class DuplicateDetector {
  constructor(@Inject(CRM_ADAPTER) private readonly crm: CrmAdapter) {}

  private signature(d: CaptureData): string {
    return createHash('sha1').update([d.person?.email, d.person?.phoneE164 ?? d.person?.phoneRaw?.replace(/\D/g, ''), norm(d.person?.name), norm(d.company?.name), d.company?.website].join('|')).digest('hex');
  }

  async refresh(tenant: TenantContext, user: UserContext, d: CaptureData): Promise<void> {
    const sig = this.signature(d);
    if (d.matches.signature === sig) return;
    d.clarifications = d.clarifications.filter((c) => !['match_person', 'match_company', 'opportunity_target'].includes(c.kind));
    const prev = { decisions: d.decisions, people: new Set(d.matches.people.map((m) => m.id)), companies: new Set(d.matches.companies.map((m) => m.id)) };
    d.decisions = {};
    d.matches = { people: [], companies: [], hiddenCount: 0, signature: sig };
    const all = { kind: 'all' as const };

    const found = new Map<string, CrmPerson>();
    const p = d.person;
    if (p?.email) for (const x of await this.crm.findPeople(tenant, { scope: all, email: p.email, limit: 10 })) found.set(x.id, x);
    if (p?.phoneE164 || p?.phoneRaw) {
      const digits = p.phoneRaw?.replace(/\D/g, '');
      for (const x of await this.crm.findPeople(tenant, { scope: all, phoneE164: p.phoneE164 ?? undefined, phoneDigits: digits, limit: 10 })) found.set(x.id, x);
    }
    if (p?.name && d.company?.name) {
      const companies = (await this.crm.findCompanies(tenant, { scope: all, nameContains: d.company.name, limit: 20 })).filter((c) => norm(c.name) === norm(d.company!.name));
      for (const c of companies) for (const x of await this.crm.findPeople(tenant, { scope: all, nameContains: p.name, companyId: c.id, limit: 10 })) found.set(x.id, x);
    }

    const accessible = [...found.values()].filter((x) => canUserAccess(user, x));
    d.matches.hiddenCount = found.size - accessible.length;
    const companyIds = [...new Set(accessible.map((x) => x.companyId).filter(Boolean))] as string[];
    const companyNames = new Map((await this.crm.getCompaniesByIds(tenant, companyIds)).filter((c) => canUserAccess(user, c)).map((c) => [c.id, c.name]));
    d.matches.people = accessible.map<MatchSummary>((x) => ({
      id: x.id, label: x.name, email: x.email, phone: x.phone ?? x.phoneRaw, company: x.companyId ? companyNames.get(x.companyId) : undefined, updatedAt: x.updatedAt,
      existing: { email: x.email, phone: x.phone ?? x.phoneRaw, title: x.title, companyId: x.companyId },
    }));

    if (d.company?.name) {
      const cs = (await this.crm.findCompanies(tenant, { scope: scopeFilterFor(user), nameContains: d.company.name, limit: 10 })).filter((c) => canUserAccess(user, c) && norm(c.name) === norm(d.company!.name));
      d.matches.companies = cs.map((c) => ({ id: c.id, label: c.name, website: c.website }));
    }

    // An answer the user already gave survives an edit unless the edit surfaced a record they were not asked about (never merge silently).
    const keep = (decision: 'new' | string | undefined, seen: Set<string>, now: string[]) =>
      decision !== undefined && now.every((id) => seen.has(id)) && (decision === 'new' || now.includes(decision));
    const peopleIds = d.matches.people.map((m) => m.id);
    const companyIds2 = d.matches.companies.map((m) => m.id);
    if (keep(prev.decisions.person, prev.people, peopleIds)) d.decisions.person = prev.decisions.person;
    else if (d.matches.people.length) d.clarifications.push(this.personQuestion(d.matches.people));
    if (keep(prev.decisions.company, prev.companies, companyIds2)) d.decisions.company = prev.decisions.company;
    else if (d.matches.companies.length) d.clarifications.push(this.companyQuestion(d));
  }

  private personQuestion(people: MatchSummary[]): Clarification {
    return {
      id: `m${++seq}`, kind: 'match_person',
      question: 'I found existing contact(s) that may be the same person. I will never merge automatically — what should I do?',
      options: [...people.map((m) => ({ id: m.id, label: `Update existing: ${m.label}${m.email ? ` (${m.email})` : ''}${m.company ? ` — ${m.company}` : ''}` })), { id: 'new', label: 'Create a new contact' }],
    };
  }

  private companyQuestion(d: CaptureData): Clarification {
    return {
      id: `m${++seq}`, kind: 'match_company',
      question: `A company named "${d.company!.name}" already exists. Companies are never merged by name alone — which should I use?`,
      options: [...d.matches.companies.map((c) => ({ id: c.id, label: `Use existing: ${c.label}${c.website ? ` (${c.website})` : ''}` })), { id: 'new', label: 'Create a new company' }],
    };
  }

  /** After the person decision: offer existing open opportunities (several are allowed, but creating another is explicit). */
  async askOpportunityTarget(tenant: TenantContext, user: UserContext, d: CaptureData): Promise<void> {
    const pid = d.decisions.person;
    if (!pid || pid === 'new' || d.decisions.opportunity || d.clarifications.some((c) => c.kind === 'opportunity_target')) return;
    const opps = await this.crm.listOpportunities(tenant, { scope: scopeFilterFor(user), personId: pid, maxRecords: 20 });
    const open = opps.items.filter((o) => !tenant.pipeline.stages.find((s) => s.id === o.stageId)?.isTerminal && canUserAccess(user, o));
    if (!open.length) { d.decisions.opportunity = 'new'; return; }
    const m = d.matches.people.find((x) => x.id === pid);
    if (m) m.openOpportunities = open.map((o) => ({ id: o.id, title: o.title, stageId: o.stageId }));
    d.clarifications.push({
      id: `m${++seq}`, kind: 'opportunity_target',
      question: 'This contact already has open opportunities. Add this to one of them, or create another opportunity?',
      options: [...open.map((o) => ({ id: o.id, label: `Add to: ${o.title} (${tenant.pipeline.stages.find((s) => s.id === o.stageId)?.label ?? o.stageId})` })), { id: 'new', label: 'Create another opportunity' }],
    });
  }
}
