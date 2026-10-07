import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '../../database/schema';

export const ROLES_KEY = 'roles';

/**
 * Role-based access control guard (Section 4).
 *
 * Role hierarchy:
 *   platform_operator > client_admin > cxo > manager > salesperson
 *
 * Record scope:
 *   - salesperson: owned/assigned only
 *   - manager: own + assigned teams
 *   - cxo: all records in tenant
 *   - client_admin: all records in tenant + config
 *   - platform_operator: all tenants (audited)
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true; // No role restriction
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user?.role) {
      throw new ForbiddenException('User role not found');
    }

    const hasRole = requiredRoles.some((role) =>
      isRoleSufficient(user.role, role),
    );

    if (!hasRole) {
      throw new ForbiddenException(
        `Role '${user.role}' does not have access. Required: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}

const ROLE_HIERARCHY: Record<UserRole, number> = {
  salesperson: 1,
  manager: 2,
  cxo: 3,
  client_admin: 4,
  platform_operator: 5,
};

/**
 * Check if userRole is at least as powerful as requiredRole.
 */
export function isRoleSufficient(
  userRole: UserRole,
  requiredRole: UserRole,
): boolean {
  return (ROLE_HIERARCHY[userRole] || 0) >= (ROLE_HIERARCHY[requiredRole] || 0);
}

/**
 * Determine the record scope for a given role.
 * Used by CRM queries to enforce authorization (Section 4).
 */
export function getRecordScope(
  role: UserRole,
  userId: string,
  teamId?: string,
  managedTeamIds?: string[],
): RecordScope {
  switch (role) {
    case 'salesperson':
      return { type: 'owned', ownerId: userId, teamId };
    case 'manager':
      return {
        type: 'team',
        ownerId: userId,
        teamId,
        managedTeamIds: managedTeamIds || [],
      };
    case 'cxo':
    case 'client_admin':
    case 'platform_operator':
      return { type: 'tenant_wide' };
    default:
      return { type: 'owned', ownerId: userId };
  }
}

export interface RecordScope {
  type: 'owned' | 'team' | 'tenant_wide';
  ownerId?: string;
  teamId?: string;
  managedTeamIds?: string[];
}

/**
 * Check if a user can access a specific record based on their scope.
 */
export function canAccessRecord(
  scope: RecordScope,
  recordOwnerId: string | undefined,
  recordTeamId?: string,
): boolean {
  switch (scope.type) {
    case 'tenant_wide':
      return true;
    case 'team':
      // Manager scope: own records plus ASSIGNED teams only (Section 4).
      if (recordOwnerId && scope.ownerId === recordOwnerId) return true;
      if (recordTeamId && scope.managedTeamIds?.includes(recordTeamId)) return true;
      return false;
    case 'owned':
      return !!recordOwnerId && scope.ownerId === recordOwnerId;
    default:
      return false;
  }
}

/**
 * Check if a user can approve archive operations.
 * Restricted to manager, CXO, or client_admin (Section 4).
 */
export function canApproveArchive(role: UserRole): boolean {
  return isRoleSufficient(role, 'manager');
}
