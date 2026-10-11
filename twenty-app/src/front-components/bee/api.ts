import { RestApiClient } from 'twenty-client-sdk/rest';

export class BeeError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

type Relay = { status: number; data: unknown };

/** Calls the CRM Bee API through the app's bee-api function (which adds the member identity and tenant secret). */
export const bee = async <T,>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> => {
  const res = (await new RestApiClient().post<unknown>('/s/bee/api', { method, path, body })) as Relay | { data: Relay };
  const r: Relay = typeof (res as Relay).status === 'number' ? (res as Relay) : (res as { data: Relay }).data;
  if (!r || r.status >= 400) {
    const msg = (r?.data as { message?: string | string[] } | null)?.message;
    throw new BeeError(Array.isArray(msg) ? msg.join('; ') : msg ?? `Bee returned ${r?.status ?? 'no response'}`, r?.status ?? 502);
  }
  return r.data as T;
};

export type Permission =
  | 'records.read' | 'records.write' | 'records.assign' | 'records.archive.request' | 'records.archive' | 'records.restore'
  | 'reports.team' | 'reports.company' | 'operations.read.all' | 'intake.review' | 'approvals.decide'
  | 'tenant.users.manage' | 'tenant.teams.manage' | 'tenant.enrollment.manage' | 'tenant.config.manage'
  | 'tenant.audit.read' | 'tenant.support.approve' | 'tenant.usage.read';

export type TenantMe = {
      platform?: undefined;
      linked: true;
      tenant: { slug: string; timezone: string };
      user: { id: string; displayName: string; email: string | null; role: string; roleLabel: string; teamId: string | null; managedTeamIds: string[]; timezone: string; morningReminderTime: string; preferredReminderChannel: string | null; channels: Array<{ channel: string; status: string; enrolledAt: string }> };
      scope: 'own' | 'team' | 'all';
      permissions: Permission[];
    };

export type Me =
  | { platform: true; linked: false; message: string }
  | { platform: true; linked: true; operator: { id: string; name: string } }
  | { linked: false; message: string; platform?: undefined }
  | TenantMe;

export type DirUser = { id: string; displayName: string; email: string | null; role: string; teamId: string | null; managedTeamIds: string[]; status: string; twentyMemberId: string | null; invitedAt: string | null; preferredReminderChannel: string | null; channels: Array<{ channel: string; status: string }> };
export type Member = { id: string; name: string; email: string | null; linkedUserId: string | null; suggestedUserId: string | null };
export type Team = { key: string; name: string; status: string; members: number; managers: number };
export type ArchiveReq = { id: string; targetType: string; targetLabel: string; reason: string | null; state: string; requestedBy: string | null; requestedAt: string; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null; operationReference: string | null };
export type IntakeItem = { id: string; reason: string | null; fields: Record<string, unknown>; receivedAt: string };
export type Grant = { id: string; reason: string; hours: number; state: string; effectiveState: string; createdAt: string; expiresAt: string | null; operator: { name: string; email: string } | null };
export type AuditEntry = { id: number; at: string; action: string; actor: string; subject: string | null; resourceType: string | null; result: string | null };
export type Config = { name: string; timezone: string; workingDays: number[]; morningReminderTime: string; defaultCurrency: string; defaultCountry: string | null; configVersion: number; pipeline: { defaultInitialStage: string; stages: Array<{ id: string; label: string; terminal?: string; requiredFields?: string[] }> } };
export type AccessReport = { ok: boolean; rolesCreated: string[]; rolesUpdated: string[]; workspaceSettingsChanged: string[]; memberChanges: Array<{ email: string | null; from: string | null; to: string }>; drift: string[]; error?: string };

export type CreatedUser = DirUser & { invitation: { sent: boolean; error?: string } | null };

export type OpenDraft = { id: string; version: number; hash: string; kind: string; text: string; expiresAt: string | null };
export type OperationView = { id: string; reference: string; state: string; saved: string[]; pending: string[]; failed: string[]; refs: Array<{ kind: string; label: string; url?: string }>; error?: string };

export type Company = { id: string; slug: string; name: string; status: string; configVersion: number; timezone: string; currency: string; workspaceUrl: string | null; users: { active: number; revoked: number }; openDeadLetters: number; pendingSupportRequests: number; lastReconciledAt: string | null; reconciliationError: string | null; createdAt: string };
export type CompanyDetail = { id: string; slug: string; name: string; status: string; configVersion: number; workspaceId: string; workspaceUrl: string | null; timezone: string; currency: string; morningReminderTime: string; workingDays: number[]; pipeline: Array<{ id: string; label: string; terminal?: string }>; serviceUser: string | null; users: Array<{ id: string; name: string; email: string | null; role: string; status: string; team: string | null; linked: boolean; invited: boolean }>; usage30d: Array<{ kind: string; total: number; events: number }>; openDeadLetters: number; supportGrants: Array<{ id: string; reason: string; hours: number; state: string; createdAt: string; expiresAt: string | null; operator: string | null }> };
export type Provisioning = { slug: string; state: 'running' | 'failed' | 'ready'; error: string | null; name?: string; request: Record<string, unknown>; steps: string[]; workspaceUrl: string | null; invitation: { sent: boolean; error?: string } | null; updatedAt: string; tenantId: string | null };
export type PlatformHealth = { companyCreation: boolean; missing: string[]; workspaceUrl: string | null };
export type OperatorRow = { id: string; name: string; email: string; status: string; signedIn: boolean; invited: boolean; lastUsedAt: string | null; createdAt: string };
export type PlatformAuditRow = { id: number; at: string; operator: string; action: string; target: string | null; result: string; metadata: Record<string, unknown> | null };
