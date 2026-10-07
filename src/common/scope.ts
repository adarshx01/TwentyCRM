import type { UserContext } from './types';
import type { ScopeFilter } from '../crm/crm-adapter.interface';
import { ownerKeyOf } from '../crm/crm-adapter.interface';
import { canAccessRecord, getRecordScope, isRoleSufficient } from './guards/roles.guard';
import type { ActionType } from './schemas';

/** Record scope (Section 4) as a server-side CRM filter. */
export function scopeFilterFor(user: UserContext): ScopeFilter {
  const scope = getRecordScope(user.role, ownerKeyOf(user), user.teamId, user.managedTeamIds);
  if (scope.type === 'tenant_wide') return { kind: 'all' };
  if (scope.type === 'team') return { kind: 'team', ownerKey: scope.ownerId, teamIds: scope.managedTeamIds };
  return { kind: 'owned', ownerKey: scope.ownerId };
}

/** Post-filter check applied to every record read from the CRM (defense in depth). */
export function canUserAccess(user: UserContext, rec: { ownerMemberId?: string; teamId?: string }): boolean {
  const scope = getRecordScope(user.role, ownerKeyOf(user), user.teamId, user.managedTeamIds);
  return canAccessRecord(scope, rec.ownerMemberId, rec.teamId);
}

/** Which roles may run which chat-driven action (Section 4 / ACT-01). */
export function roleMayPerform(role: UserContext['role'], action: ActionType): boolean {
  if (role === 'platform_operator') return false; // service role: no customer data via chat
  switch (action) {
    case 'assign':
    case 'archive':
    case 'restore':
      return isRoleSufficient(role, 'manager');
    default:
      return true;
  }
}
