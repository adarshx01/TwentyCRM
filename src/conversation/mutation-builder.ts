import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { AllowedAction, LlmIntent } from '../common/schemas';
import type { TenantContext, UserContext } from '../common/types';
import { CRM_ADAPTER, ownerKeyOf, type CrmAdapter } from '../crm/crm-adapter.interface';
import { canUserAccess, roleMayPerform, scopeFilterFor } from '../common/scope';
import { parseTimeExpression, resolveRelativeDate } from '../common/utils/date.util';
import { IdentityService } from '../identity/identity.service';
import type { MutationData } from './draft.types';
import { ArchiveRequestService } from '../approvals/archive-request.service';
import { can } from '../access/permissions';

type Entity = 'person' | 'company' | 'opportunity' | 'task';
export type Choice = { entity: Entity; id: string; label: string };

export type BuildResult =
  | { kind: 'ready'; action: AllowedAction; data: MutationData }
  | { kind: 'choose'; question: string; choices: Choice[] }
  | { kind: 'message'; text: string };

const fmtTask = (t: { dueAt?: string; dueDate?: string; hasTime: boolean; timezone?: string }, tz: string) =>
  t.hasTime && t.dueAt ? DateTime.fromISO(t.dueAt, { zone: 'utc' }).setZone(t.timezone ?? tz).toFormat('ccc d LLL yyyy, h:mm a') : t.dueDate ? `${DateTime.fromISO(t.dueDate).toFormat('ccc d LLL yyyy')} (date only)` : 'no date';

/**
 * Turns a model-proposed intent into an executable action. The model supplies only free text
 * ("Rajesh at ABC"); targets are resolved here against records the user may access, and an
 * ambiguous reference is never guessed (CAP-02, Section 6).
 */
@Injectable()
export class MutationBuilder {
  constructor(
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    private readonly identity: IdentityService,
    private readonly archiveRequests: ArchiveRequestService,
  ) {}

  stageIdFor(tenant: TenantContext, label: string): string | undefined {
    const l = label.trim().toLowerCase();
    return tenant.pipeline.stages.find((s) => s.id.toLowerCase() === l || s.label.toLowerCase() === l)?.id
      ?? tenant.pipeline.stages.find((s) => s.label.toLowerCase().startsWith(l) && l.length >= 3)?.id;
  }

  private async search(tenant: TenantContext, user: UserContext, query: string, entities: Entity[], includeArchived = false): Promise<Choice[]> {
    const scope = scopeFilterFor(user);
    const out: Choice[] = [];
    const words = query.replace(/\bat\b/gi, ' ').trim();
    const oppRefs = { people: new Set<string>(), companies: new Set<string>() };
    if (entities.includes('opportunity')) {
      for (const o of (await this.crm.listOpportunities(tenant, { scope, titleContains: words.split(/\s+/)[0], archived: includeArchived ? true : undefined, maxRecords: 30 })).items.filter((x) => canUserAccess(user, x))) {
        if (words.split(/\s+/).every((w) => o.title.toLowerCase().includes(w.toLowerCase()))) {
          if (o.personId) oppRefs.people.add(o.personId);
          if (o.companyId) oppRefs.companies.add(o.companyId);
        }
        if (words.split(/\s+/).every((w) => o.title.toLowerCase().includes(w.toLowerCase()))) out.push({ entity: 'opportunity', id: o.id, label: `${o.title} (opportunity, ${tenant.pipeline.stages.find((s) => s.id === o.stageId)?.label ?? o.stageId})` });
      }
    }
    if (entities.includes('person')) {
      // A contact that is the point of contact of a matching opportunity is the same "lead": offer one choice, not two.
      for (const p of (await this.crm.findPeople(tenant, { scope, nameContains: words, includeArchived, limit: 10 })).filter((x) => canUserAccess(user, x) && (!includeArchived || x.archived) && !oppRefs.people.has(x.id))) out.push({ entity: 'person', id: p.id, label: `${p.name} (contact)` });
    }
    if (entities.includes('company')) {
      for (const c of (await this.crm.findCompanies(tenant, { scope, nameContains: words, includeArchived, limit: 10 })).filter((x) => canUserAccess(user, x) && (!includeArchived || x.archived) && !oppRefs.companies.has(x.id))) out.push({ entity: 'company', id: c.id, label: `${c.name} (company)` });
    }
    return out;
  }

  /** Find records for read-only "search" requests. */
  async find(tenant: TenantContext, user: UserContext, query: string): Promise<Choice[]> {
    return this.search(tenant, user, query, ['person', 'company', 'opportunity']);
  }

  async build(tenant: TenantContext, user: UserContext, intent: LlmIntent, chosen?: Choice, nowIso?: string): Promise<BuildResult> {
    const kind = intent.intent;
    const action: AllowedAction['type'] | null = (['update_stage', 'add_note', 'create_task', 'reschedule', 'assign', 'archive', 'restore'] as const).find((k) => k === kind) ?? null;
    if (!action) return { kind: 'message', text: 'I can only save changes I understand. Try "move Rajesh to Proposal" or "note: …".' };

    // §4: a salesperson cannot archive, but can REQUEST it; an approver with scope over the record decides later.
    const requestOnly = action === 'archive' && !roleMayPerform(user.role, 'archive') && can(user.role, 'records.archive.request');
    if (!requestOnly && !roleMayPerform(user.role, action)) return { kind: 'message', text: 'Your role cannot perform this action. A manager, CXO or administrator can.' };

    // create_task without a target is a standalone task owned by the user.
    if (action === 'create_task' && !intent.targetQuery && !chosen) return this.createTask(tenant, user, intent, undefined, nowIso);
    const entities: Entity[] = action === 'update_stage' ? ['opportunity'] : action === 'reschedule' ? ['task'] : action === 'create_task' ? ['opportunity', 'person'] : ['person', 'company', 'opportunity'];
    let target = chosen;
    if (!target) {
      if (!intent.targetQuery) return { kind: 'message', text: 'Which record do you mean? For example: "Rajesh at ABC".' };
      let choices: Choice[];
      if (action === 'reschedule') choices = await this.findTasks(tenant, user, intent.targetQuery);
      else choices = await this.search(tenant, user, intent.targetQuery, entities, action === 'restore');
      if (!choices.length) return { kind: 'message', text: `I couldn't find "${intent.targetQuery}" in your accessible records.` };
      if (choices.length > 1) return { kind: 'choose', question: `Several records match "${intent.targetQuery}". Which one?`, choices: choices.slice(0, 8) };
      target = choices[0];
    }
    switch (action) {
      case 'update_stage': return this.updateStage(tenant, user, intent, target);
      case 'add_note': return this.addNote(tenant, user, intent, target);
      case 'create_task': return this.createTask(tenant, user, intent, target, nowIso);
      case 'reschedule': return this.reschedule(tenant, user, intent, target, nowIso);
      case 'assign': return this.assign(tenant, user, intent, target);
      case 'archive': return requestOnly ? this.requestArchive(tenant, user, target) : this.archive(tenant, user, target);
      case 'restore': return this.restore(tenant, user, target);
    }
    return { kind: 'message', text: 'Unsupported request.' };
  }

  private async findTasks(tenant: TenantContext, user: UserContext, query: string): Promise<Choice[]> {
    const scope = scopeFilterFor(user);
    const tasks = (await this.crm.listTasks(tenant, { scope, status: 'open', maxRecords: 200 })).items.filter((t) => canUserAccess(user, t));
    const people = new Map((await this.crm.getPeopleByIds(tenant, tasks.map((t) => t.personId).filter(Boolean) as string[])).map((p) => [p.id, p]));
    const q = query.toLowerCase().replace(/'s\b/g, '').split(/\s+/).filter((w) => w.length > 2 && !['meeting', 'tomorrow', 'today', 'task', 'the'].includes(w));
    return tasks.filter((t) => {
      const hay = `${t.title} ${t.personId ? people.get(t.personId)?.name ?? '' : ''}`.toLowerCase();
      return q.length === 0 ? true : q.every((w) => hay.includes(w));
    }).slice(0, 8).map((t) => ({ entity: 'task' as const, id: t.id, label: `${t.title} — ${fmtTask(t, user.timezone)}` }));
  }

  private async updateStage(tenant: TenantContext, user: UserContext, intent: LlmIntent, target: Choice): Promise<BuildResult> {
    if (target.entity !== 'opportunity') return { kind: 'message', text: 'Stage changes apply to opportunities. Try naming the opportunity, e.g. "move ABC deal to Proposal".' };
    if (!intent.newStage) return { kind: 'message', text: `Which stage? Options: ${tenant.pipeline.stages.map((s) => s.label).join(', ')}.` };
    const stageId = this.stageIdFor(tenant, intent.newStage);
    if (!stageId) return { kind: 'message', text: `"${intent.newStage}" is not a stage here. Options: ${tenant.pipeline.stages.map((s) => s.label).join(', ')}.` };
    const opp = await this.crm.getOpportunity(tenant, target.id);
    if (!opp || !canUserAccess(user, opp)) return { kind: 'message', text: "I couldn't find that record in your accessible records." };
    const stage = tenant.pipeline.stages.find((s) => s.id === stageId)!;
    const missing = (stage.requiredFields ?? []).filter((f) => (f === 'amount' && opp.amountMicros == null && intent.amount == null) || (f === 'lostReason' && !opp.lostReason) || (f === 'closeDate' && !opp.closeDate));
    if (missing.length) return { kind: 'message', text: `Moving to ${stage.label} needs: ${missing.join(', ')}. Add it first (e.g. "set amount 50000 INR" on the opportunity).` };
    if (opp.stageId === stageId) return { kind: 'message', text: `${opp.title} is already in ${stage.label}.` };
    const from = tenant.pipeline.stages.find((s) => s.id === opp.stageId)?.label ?? opp.stageId;
    return {
      kind: 'ready',
      action: { type: 'update_stage', opportunityId: opp.id, newStageId: stageId, expectedVersion: opp.updatedAt, ...(intent.amount != null ? { amount: intent.amount, currency: intent.currency ?? tenant.defaultCurrency } : {}) },
      data: { kind: 'mutation', summaryLines: [`*Stage change:* ${opp.title}`, `   ${from} → *${stage.label}*`], warnings: stage.isTerminal ? [`${stage.label} is a closing stage.`] : [] },
    };
  }

  private async addNote(tenant: TenantContext, user: UserContext, intent: LlmIntent, target: Choice): Promise<BuildResult> {
    const text = intent.notes?.[0] ?? intent.interest;
    if (!text) return { kind: 'message', text: 'What should the note say? Reply like "note: proposal requested".' };
    if (target.entity === 'task') return { kind: 'message', text: 'Notes attach to a contact, company or opportunity.' };
    const rec = target.entity === 'person' ? await this.crm.getPerson(tenant, target.id) : target.entity === 'company' ? await this.crm.getCompany(tenant, target.id) : await this.crm.getOpportunity(tenant, target.id);
    if (!rec || !canUserAccess(user, rec)) return { kind: 'message', text: "I couldn't find that record in your accessible records." };
    return {
      kind: 'ready',
      action: { type: 'add_note', targetType: target.entity, targetId: target.id, note: { text: text.slice(0, 4000), type: 'observation' }, expectedVersion: rec.updatedAt },
      data: { kind: 'mutation', summaryLines: [`*Note on:* ${target.label}`, `   "${text.slice(0, 300)}"`, '_Recorded as an observation (no task is created unless you ask for one)._'], warnings: [] },
    };
  }

  private async createTask(tenant: TenantContext, user: UserContext, intent: LlmIntent, target: Choice | undefined, nowIso?: string): Promise<BuildResult> {
    const t = intent.tasks?.[0] ?? { title: intent.opportunityTitle ?? 'Follow up', type: 'follow_up' as const, dateExpression: intent.dateExpression, timeExpression: intent.timeExpression };
    const expr = t.dateExpression ?? intent.dateExpression;
    if (!expr) return { kind: 'message', text: `When should I schedule "${t.title}"? Give a date, e.g. "next Tuesday".` };
    const r = resolveRelativeDate(expr, user.timezone, nowIso);
    if (!r.date) return { kind: 'message', text: `I can't pin down that date (${r.reason}). Please give a date like "29 September" or "next Tuesday".` };
    const time = parseTimeExpression(t.timeExpression ?? intent.timeExpression) ?? r.time;
    if (t.type === 'meeting' && !time) return { kind: 'message', text: `What time is the meeting on ${r.date}? A meeting needs an explicit date and time (or I can save a date-only follow-up).` };
    const tt = target && (target.entity === 'person' || target.entity === 'opportunity') ? target : undefined;
    return {
      kind: 'ready',
      action: { type: 'create_task', ...(tt ? { targetType: tt.entity as 'person' | 'opportunity', targetId: tt.id } : {}), task: { title: t.title.slice(0, 200), type: t.type, dueDate: r.date, dueTime: time ?? undefined, timezone: user.timezone, location: t.location } },
      data: { kind: 'mutation', summaryLines: [`*${t.type === 'meeting' ? 'Meeting' : 'Task'}:* ${t.title}`, `   When: ${time ? `${DateTime.fromISO(`${r.date}T${time}`, { zone: user.timezone }).toFormat('ccc d LLL yyyy, h:mm a')} ${user.timezone}` : `${DateTime.fromISO(r.date).toFormat('ccc d LLL yyyy')} (date only)`}${expr ? ` _(you said: "${expr}")_` : ''}`, tt ? `   Linked to: ${tt.label}` : '   Not linked to a record'], warnings: [] },
    };
  }

  private async reschedule(tenant: TenantContext, user: UserContext, intent: LlmIntent, target: Choice, nowIso?: string): Promise<BuildResult> {
    if (target.entity !== 'task') return { kind: 'message', text: 'Only tasks and meetings can be rescheduled.' };
    const task = await this.crm.getTask(tenant, target.id);
    if (!task || !canUserAccess(user, task)) return { kind: 'message', text: "I couldn't find that task in your accessible records." };
    const expr = intent.dateExpression ?? intent.tasks?.[0]?.dateExpression;
    if (!expr) return { kind: 'message', text: 'To which date should I move it?' };
    const r = resolveRelativeDate(expr, user.timezone, nowIso);
    if (!r.date) return { kind: 'message', text: `I can't pin down that date (${r.reason}). Please give a date like "Friday" or "29 September".` };
    // A time the user gave but we cannot read is asked about; only when none was given do we keep the meeting's existing time.
    const timeGiven = Boolean(intent.timeExpression) || /\bat\s+\d/i.test(expr);
    const parsedTime = parseTimeExpression(intent.timeExpression ?? expr);
    if (timeGiven && !parsedTime) return { kind: 'message', text: 'What time should it move to? Please include AM/PM or use 24-hour time like 15:00.' };
    const time = parsedTime ?? (task.hasTime && task.dueAt ? DateTime.fromISO(task.dueAt, { zone: 'utc' }).setZone(task.timezone ?? user.timezone).toFormat('HH:mm') : null);
    if (task.kind === 'meeting' && !time) return { kind: 'message', text: 'What time should the meeting move to? Please include AM/PM or use 24-hour time like 15:00.' };
    const newWhen = time ? `${DateTime.fromISO(`${r.date}T${time}`, { zone: user.timezone }).toFormat('ccc d LLL yyyy, h:mm a')} ${user.timezone}` : `${DateTime.fromISO(r.date).toFormat('ccc d LLL yyyy')} (date only)`;
    return {
      kind: 'ready',
      action: { type: 'reschedule', taskId: task.id, newDate: r.date, newTime: time ?? undefined, timezone: user.timezone, expectedVersion: task.updatedAt },
      data: { kind: 'mutation', summaryLines: [`*Reschedule:* ${task.title}`, `   Old: ${fmtTask(task, user.timezone)}`, `   New: ${newWhen}`, '_The existing schedule is replaced, not duplicated._'], warnings: [] },
    };
  }

  private async assign(tenant: TenantContext, user: UserContext, intent: LlmIntent, target: Choice): Promise<BuildResult> {
    if (target.entity === 'task') { /* allowed */ }
    if (!intent.newOwnerName) return { kind: 'message', text: 'Who should own it?' };
    const people = await this.identity.findUsersByName(tenant.tenantId, intent.newOwnerName);
    if (!people.length) return { kind: 'message', text: `I couldn't find an active member named "${intent.newOwnerName}" in this workspace.` };
    if (people.length > 1) return { kind: 'message', text: `Several members match "${intent.newOwnerName}": ${people.map((p) => p.displayName).join(', ')}. Please use the full name.` };
    const owner = people[0];
    const rec = target.entity === 'person' ? await this.crm.getPerson(tenant, target.id) : target.entity === 'company' ? await this.crm.getCompany(tenant, target.id) : target.entity === 'opportunity' ? await this.crm.getOpportunity(tenant, target.id) : await this.crm.getTask(tenant, target.id);
    if (!rec || !canUserAccess(user, rec)) return { kind: 'message', text: "I couldn't find that record in your accessible records." };
    let cascade: string[] = [];
    if (target.entity === 'opportunity') {
      const tasks = await this.crm.listTasks(tenant, { scope: scopeFilterFor(user), status: 'open', opportunityId: target.id, maxRecords: 50 });
      cascade = tasks.items.filter((t) => canUserAccess(user, t)).map((t) => t.id);
    }
    if (user.role === 'manager' && owner.userId !== user.userId && !(owner.teamId && user.managedTeamIds.includes(owner.teamId))) {
      return { kind: 'message', text: 'You can only assign within the teams you manage.' };
    }
    return {
      kind: 'ready',
      action: { type: 'assign', targetType: target.entity as any, targetId: target.id, newOwnerUserId: owner.userId, expectedVersion: rec.updatedAt, cascadeTaskIds: cascade },
      data: { kind: 'mutation', summaryLines: [`*Reassign:* ${target.label}`, `   Owner: ${rec.ownerMemberId === ownerKeyOf(user) ? 'you' : (rec.ownerMemberId ?? 'unassigned')} → *${owner.displayName}*`, ...(cascade.length ? [`   ${cascade.length} open task(s) linked to it will move to ${owner.displayName} too`] : [])], warnings: [] },
    };
  }

  private async archive(tenant: TenantContext, user: UserContext, target: Choice): Promise<BuildResult> {
    if (target.entity === 'task') return { kind: 'message', text: 'Tasks are completed rather than archived. Say "complete" in Twenty, or archive the opportunity.' };
    const rec = target.entity === 'person' ? await this.crm.getPerson(tenant, target.id) : target.entity === 'company' ? await this.crm.getCompany(tenant, target.id) : await this.crm.getOpportunity(tenant, target.id);
    if (!rec || !canUserAccess(user, rec)) return { kind: 'message', text: "I couldn't find that record in your accessible records." };
    let cascade: string[] = [];
    if (target.entity === 'opportunity') {
      const tasks = await this.crm.listTasks(tenant, { scope: scopeFilterFor(user), status: 'open', opportunityId: target.id, maxRecords: 50 });
      cascade = tasks.items.filter((t) => canUserAccess(user, t)).map((t) => t.id);
    }
    return {
      kind: 'ready',
      action: { type: 'archive', targetType: target.entity, targetId: target.id, expectedVersion: rec.updatedAt, cascadeTaskIds: cascade },
      data: { kind: 'mutation', summaryLines: [`*Archive:* ${target.label}`, '   Nothing is permanently deleted — an archived record can be restored.', '   It leaves active searches and reminders.', ...(cascade.length ? [`   ${cascade.length} open task(s) linked to it are archived with it`] : [])], warnings: [] },
    };
  }

  private async requestArchive(tenant: TenantContext, user: UserContext, target: Choice): Promise<BuildResult> {
    if (target.entity === 'task') return { kind: 'message', text: 'Tasks are completed rather than archived.' };
    try {
      const r = await this.archiveRequests.create(tenant, user, { entity: target.entity, id: target.id, label: target.label });
      return {
        kind: 'message',
        text: r.existing
          ? `An archive request for ${target.label} is already waiting for a manager, CXO or administrator.`
          : `📨 Archive requested for ${target.label}.\nRecords are never permanently deleted; archiving needs approval from a manager, CXO or administrator with access to it. Nothing changes until they approve it in Bee › Approvals.`,
      };
    } catch (e) {
      return { kind: 'message', text: (e as Error).message };
    }
  }

  private async restore(tenant: TenantContext, user: UserContext, target: Choice): Promise<BuildResult> {
    if (target.entity === 'task') return { kind: 'message', text: 'Restore applies to contacts, companies and opportunities.' };
    const rec = target.entity === 'person' ? await this.crm.getPerson(tenant, target.id) : target.entity === 'company' ? await this.crm.getCompany(tenant, target.id) : await this.crm.getOpportunity(tenant, target.id);
    if (!rec || !canUserAccess(user, rec) || !rec.archived) return { kind: 'message', text: "I couldn't find an archived record like that in your accessible records." };
    return {
      kind: 'ready',
      action: { type: 'restore', targetType: target.entity, targetId: target.id, expectedVersion: rec.updatedAt },
      data: { kind: 'mutation', summaryLines: [`*Restore:* ${target.label}`, '   Tasks archived with it stay archived and completed tasks are not changed.', '   Earlier reminders are not re-sent.'], warnings: [] },
    };
  }
}
