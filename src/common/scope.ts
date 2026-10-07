import type { UserContext } from './types';
import type { ScopeFilter } from '../crm/crm-adapter.interface';
import { ownerKeyOf } from '../crm/crm-adapter.interface';
import { can, recordScopeOf, type Permission } from '../access/permissions';
import type { ActionType } from './schemas';

/** Record scope (§4) as a server-side CRM filter. */
export function scopeFilterFor(user: UserContext): ScopeFilter {
  switch (recordScopeOf(user.role)) {
    case 'all': return { kind: 'all' };
    case 'team': return { kind: 'team', ownerKey: ownerKeyOf(user), teamIds: user.managedTeamIds };
    default: return { kind: 'owned', ownerKey: ownerKeyOf(user) };
  }
}

/**
 * Post-filter applied to every record read from the CRM (defense in depth). A manager's own team is NOT implicitly
 * managed: only teams assigned to them count (§4 "own records and assigned teams").
 */
export function canUserAccess(user: UserContext, rec: { ownerMemberId?: string; teamId?: string }): boolean {
  const mine = !!rec.ownerMemberId && rec.ownerMemberId === ownerKeyOf(user);
  switch (recordScopeOf(user.role)) {
    case 'all': return true;
    case 'team': return mine || (!!rec.teamId && user.managedTeamIds.includes(rec.teamId));
    default: return mine;
  }
}

const ACTION_PERMISSION: Record<ActionType, Permission> = {
  capture_lead: 'records.write',
  update_stage: 'records.write',
  add_note: 'records.write',
  create_task: 'records.write',
  reschedule: 'records.write',
  assign: 'records.assign',
  archive: 'records.archive',
  restore: 'records.restore',
};

/** Which roles may run which chat-driven action (§4, ACT-01). Unknown roles get nothing. */
export function roleMayPerform(role: UserContext['role'], action: ActionType): boolean {
  const p = ACTION_PERMISSION[action];
  return !!p && can(role, p);
}
