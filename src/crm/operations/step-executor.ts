import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { TenantContext, UserContext } from '../../common/types';
import type { OperationStep } from '../../database/schema';
import { CRM_ADAPTER, ownerKeyOf, type CrmAdapter, type TaskInput } from '../crm-adapter.interface';
import { IdentityService } from '../../identity/identity.service';
import { PermanentError } from '../../common/errors';

export interface StepContext {
  tenant: TenantContext;
  /** Acting employee (the confirming user) */
  actor: UserContext;
  operationId: string;
  channel?: string;
  sourceEventIds: string[];
  results: Map<string, string>;
  /** Owner of created records; defaults to actor */
  ownerUserId?: string;
}

interface Owner { ownerKey: string; teamId?: string }

/** Executes ONE journal step against the CRM. Every create is idempotent via the operation key. */
@Injectable()
export class StepExecutor {
  constructor(
    @Inject(CRM_ADAPTER) private readonly crm: CrmAdapter,
    private readonly identity: IdentityService,
  ) {}

  private async owner(ctx: StepContext): Promise<Owner> {
    if (!ctx.ownerUserId || ctx.ownerUserId === ctx.actor.userId) return { ownerKey: ownerKeyOf(ctx.actor), teamId: ctx.actor.teamId };
    const res = await this.identity.getActiveUser(ctx.tenant.tenantId, ctx.ownerUserId);
    if (!res) throw new PermanentError('The assigned owner is no longer an active member.', 'OWNER_INACTIVE');
    return { ownerKey: ownerKeyOf(res.user), teamId: res.user.teamId };
  }

  /** Returns the external record ID produced/confirmed by the step. */
  async run(step: OperationStep, ctx: StepContext): Promise<string> {
    const key = `${ctx.operationId}:${step.key}`;
    const p = (step.payload ?? {}) as Record<string, any>;
    const prov = async () => {
      const o = await this.owner(ctx);
      return { ownerKey: o.ownerKey, teamId: o.teamId, channel: ctx.channel, sourceEventIds: ctx.sourceEventIds };
    };

    switch (step.kind) {
      case 'link_person': case 'link_company': case 'link_opportunity':
        return p.id as string;

      case 'create_person': {
        const x = p.person;
        const [first, ...rest] = String(x.name ?? x.firstName ?? '').trim().split(/\s+/);
        const companyId = ctx.results.get('company');
        const created = await this.crm.createPerson(ctx.tenant, {
          firstName: x.firstName ?? first ?? '', lastName: x.lastName ?? (rest.join(' ') || undefined),
          email: x.email, phoneE164: x.phoneE164, phoneRaw: x.phoneRaw ?? x.phone, title: x.title, companyId, ...(await prov()),
        }, key);
        return created.id;
      }
      case 'update_person': {
        const patch = { ...p.patch } as Record<string, any>;
        if (!patch.companyId && ctx.results.get('company')) patch.companyId = ctx.results.get('company');
        await this.crm.updatePerson(ctx.tenant, p.id, patch);
        return p.id;
      }
      case 'create_company': {
        const c = p.company;
        return (await this.crm.createCompany(ctx.tenant, { name: c.name, website: c.website, domain: c.domain, address: c.address, country: c.country, ...(await prov()) }, key)).id;
      }
      case 'create_opportunity': {
        const o = p.opportunity;
        return (await this.crm.createOpportunity(ctx.tenant, {
          title: o.title, stageId: o.stageId ?? ctx.tenant.pipeline.defaultInitialStage,
          personId: ctx.results.get('person'), companyId: ctx.results.get('company'),
          amountMicros: o.amount != null ? Math.round(o.amount * 1_000_000) : undefined, currency: o.currency,
          closeDate: o.expectedCloseDate, interest: o.interest, source: o.source, ...(await prov()),
        }, key)).id;
      }
      case 'create_note': {
        const n = p.note;
        const targets = p.target
          ? { [`${p.target.type}Id`]: p.target.id }
          : { personId: ctx.results.get('person'), companyId: ctx.results.get('company'), opportunityId: ctx.results.get('opportunity') };
        const text = String(n.text);
        return (await this.crm.createNote(ctx.tenant, {
          title: text.length > 60 ? `${text.slice(0, 57)}…` : text, text, noteType: n.type, eventTime: n.eventTime, authorKey: ownerKeyOf(ctx.actor),
          targets, ...(await prov()),
        }, key)).id;
      }
      case 'create_task': {
        const t = p.task;
        const targets = p.target
          ? { [`${p.target.type}Id`]: p.target.id }
          : { personId: ctx.results.get('person'), companyId: ctx.results.get('company'), opportunityId: ctx.results.get('opportunity') };
        const o = await this.owner(ctx);
        const tz = t.timezone ?? ctx.actor.timezone;
        const input: TaskInput = {
          title: t.title, kind: t.type, dueDate: t.dueDate, hasTime: Boolean(t.dueTime), timezone: tz, durationMin: t.duration, location: t.location,
          assigneeKey: t.assigneeId ?? o.ownerKey, targets, ownerKey: o.ownerKey, teamId: o.teamId, channel: ctx.channel, sourceEventIds: ctx.sourceEventIds,
          dueAt: t.dueDate && t.dueTime ? DateTime.fromISO(`${t.dueDate}T${t.dueTime}`, { zone: tz }).toUTC().toISO()! : undefined,
        };
        return (await this.crm.createTask(ctx.tenant, input, key)).id;
      }
      case 'update_stage': {
        await this.crm.updateOpportunity(ctx.tenant, p.id, { stageId: p.stageId, lostReason: p.lostReason, amountMicros: p.amount != null ? Math.round(p.amount * 1_000_000) : undefined, currency: p.currency });
        return p.id;
      }
      case 'update_task': {
        const tz = p.timezone ?? ctx.actor.timezone;
        const hasTime = Boolean(p.time);
        const dueAt = hasTime
          ? DateTime.fromISO(`${p.date}T${p.time}`, { zone: tz }).toUTC().toISO()!
          : DateTime.fromISO(p.date, { zone: tz }).startOf('day').toUTC().toISO()!;
        await this.crm.updateTask(ctx.tenant, p.id, { dueAt, dueDate: p.date, hasTime, timezone: tz });
        return p.id;
      }
      case 'assign': {
        const res = await this.identity.getActiveUser(ctx.tenant.tenantId, p.ownerUserId);
        if (!res) throw new PermanentError('The new owner is not an active member of this workspace.', 'OWNER_INACTIVE');
        await this.crm.assignOwner(ctx.tenant, p.entity, p.id, ownerKeyOf(res.user), res.user.teamId);
        return p.id;
      }
      case 'archive':
        await this.crm.setArchived(ctx.tenant, p.entity, p.id, true);
        return p.id;
      case 'restore':
        await this.crm.setArchived(ctx.tenant, p.entity, p.id, false);
        return p.id;
      default:
        throw new PermanentError(`Unknown step kind ${step.kind}`);
    }
  }
}
