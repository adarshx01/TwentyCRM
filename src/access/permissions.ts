/**
 * The access model of the BRD (§4) as data. docs/access-architecture.md §3 is the human-readable form of this file;
 * change both together. Nothing here is inferred from a numeric rank: a role has exactly the permissions listed.
 *
 * Two planes:
 *  - tenant plane: the four roles an employee of a client can hold (salesperson, manager, cxo, client_admin);
 *  - platform plane: YlogX operators, authenticated separately (src/access/operator.ts) and never a tenant role.
 */

export const TENANT_ROLES = ['salesperson', 'manager', 'cxo', 'client_admin'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** Record scope (§4): own = owned or assigned, team = own + assigned teams, all = every record of the client. */
export type RecordScopeKind = 'own' | 'team' | 'all';

export const PERMISSIONS = [
  // CRM records (always further limited by the role's record scope)
  'records.read',
  'records.write', //            capture, edit fields, notes, stage moves, tasks, reschedule
  'records.assign', //           change owner (manager: only within assigned teams)
  'records.archive.request', //  ask an approver to archive (salesperson)
  'records.archive', //          archive directly / approve an archive request
  'records.restore',
  // reporting (SUM-01)
  'reports.team',
  'reports.company',
  // operations and review
  'operations.read.all', //      see other employees' operation status in the tenant
  'intake.review', //            approve / reject intake review items (IN-11, AT-20)
  'approvals.decide', //         decide archive requests
  // tenant administration (client admin, own tenant only)
  'tenant.users.manage',
  'tenant.teams.manage',
  'tenant.enrollment.manage',
  'tenant.config.manage',
  'tenant.audit.read',
  'tenant.support.approve',
  'tenant.usage.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const SALES: Permission[] = ['records.read', 'records.write'];

/** Role → record scope and permissions. Client admin = administration + CXO record rights (decision A2). */
export const ROLE_MATRIX: Readonly<Record<TenantRole, { scope: RecordScopeKind; label: string; permissions: readonly Permission[] }>> = {
  salesperson: { scope: 'own', label: 'Salesperson', permissions: [...SALES, 'records.archive.request'] },
  manager: { scope: 'team', label: 'Manager', permissions: [...SALES, 'records.assign', 'records.archive', 'records.restore', 'reports.team', 'intake.review', 'approvals.decide'] },
  cxo: { scope: 'all', label: 'CXO', permissions: [...SALES, 'records.assign', 'records.archive', 'records.restore', 'reports.team', 'reports.company', 'operations.read.all', 'intake.review', 'approvals.decide'] },
  client_admin: {
    scope: 'all',
    label: 'Client admin',
    permissions: [
      ...SALES, 'records.assign', 'records.archive', 'records.restore', 'reports.team', 'reports.company', 'operations.read.all', 'intake.review', 'approvals.decide',
      'tenant.users.manage', 'tenant.teams.manage', 'tenant.enrollment.manage', 'tenant.config.manage', 'tenant.audit.read', 'tenant.support.approve', 'tenant.usage.read',
    ],
  },
};

export const isTenantRole = (r: unknown): r is TenantRole => typeof r === 'string' && (TENANT_ROLES as readonly string[]).includes(r);

export function can(role: string | undefined, permission: Permission): boolean {
  return isTenantRole(role) && ROLE_MATRIX[role].permissions.includes(permission);
}

export function permissionsOf(role: string | undefined): Permission[] {
  return isTenantRole(role) ? [...ROLE_MATRIX[role].permissions] : [];
}

export function recordScopeOf(role: string | undefined): RecordScopeKind {
  return isTenantRole(role) ? ROLE_MATRIX[role].scope : 'own';
}

/**
 * Twenty-native counterpart of each tenant role (decision A1: without a Twenty Organization key, salespeople and
 * managers get no direct record screens; Bee enforces their scope in Ask AI › Bee, WhatsApp and Teams).
 */
export const TWENTY_ROLE_LABELS = {
  salesperson: 'Bee · Salesperson',
  manager: 'Bee · Manager',
  cxo: 'Bee · CXO',
  client_admin: 'Admin', // Twenty's built-in administrator: company-wide by design (§4)
  none: 'Bee · No access',
} as const;
