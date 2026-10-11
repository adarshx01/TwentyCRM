import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { FETCH_FN } from '../crm/twenty/twenty-client';
import { SECRET_RESOLVER, type SecretResolver } from '../secrets/secret-resolver';

export interface CreatedWorkspace {
  workspaceId: string;
  /** Browser/API base URL of the workspace, e.g. http://acme.localhost:3020 */
  url: string;
  subdomain: string;
}

/** Everything Bee needs from a Twenty server to create a company workspace (BRD §1: shared multi-workspace instance). */
export interface WorkspaceFactory {
  /** Create + activate a workspace owned by the platform account and give it its public subdomain. */
  createWorkspace(input: { displayName: string; subdomain: string }): Promise<CreatedWorkspace>;
  /** Mint the integration API key (Admin at first; Bee downgrades it to "Bee · Integration" once provisioned). */
  createApiKey(ws: CreatedWorkspace): Promise<string>;
  /** Create the per-workspace Bee service user (Admin seat) and return nothing; credentials are chosen by the caller. */
  createServiceUser(ws: CreatedWorkspace, email: string, password: string): Promise<void>;
  /** Install the registered CRM Bee app into the workspace. */
  installApp(ws: CreatedWorkspace, appUniversalId: string): Promise<void>;
  /** Remove the platform account from the workspace (operators are not members of client workspaces). */
  removePlatformAccount(ws: CreatedWorkspace): Promise<boolean>;
  /** Whether a workspace with this subdomain already exists on the instance. */
  subdomainTaken(subdomain: string): Promise<boolean>;
  /** Members of the platform (operations) workspace, for linking operators. */
  listPlatformMembers(): Promise<Array<{ id: string; email: string | null }>>;
  /** Invite an operator's e-mail into the platform workspace. */
  invitePlatformMember(email: string): Promise<{ sent: boolean; error?: string }>;
}
export const WORKSPACE_FACTORY = 'WORKSPACE_FACTORY';

class TwentyError extends Error {}

/**
 * Real implementation against a Twenty server in multi-workspace mode. It authenticates as the platform's server-admin
 * account (IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS stays true: no public self-service creation, TEN-05).
 */
@Injectable()
export class TwentyWorkspaceFactory implements WorkspaceFactory {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FETCH_FN) private readonly fetchFn: typeof fetch,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
  ) {}

  private get base(): string {
    const u = this.config.platform.twentyUrl;
    if (!u) throw new TwentyError('PLATFORM_TWENTY_URL is not configured: company creation is disabled.');
    return u.replace(/\/$/, '');
  }

  private async call<T = any>(host: string, query: string, variables: Record<string, unknown> = {}, token?: string): Promise<T> {
    // Retry connection failures: Twenty may be restarting, or a brand-new workspace address is still getting its certificate.
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.fetchFn(`${host}/metadata`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: host, ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status !== 502 && res.status !== 503 && res.status !== 504) break;
      } catch (e) {
        if (attempt >= 7) throw new TwentyError(`Twenty is not reachable at ${host}: ${(e as Error).message}`);
      }
      if (attempt >= 7) break;
      await new Promise((r) => setTimeout(r, 4000));
    }
    if (!res) throw new TwentyError(`Twenty is not reachable at ${host}`);
    const j = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (j.errors?.length) throw new TwentyError(j.errors[0].message);
    return j.data as T;
  }

  private async platformCredentials(): Promise<{ email: string; password: string }> {
    const { adminEmail, adminPasswordRef } = this.config.platform;
    if (!adminEmail || !adminPasswordRef) throw new TwentyError('PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD are not configured.');
    return { email: adminEmail, password: await this.secrets.resolve(adminPasswordRef) };
  }

  private async login(host: string, email: string, password: string): Promise<string> {
    const a = await this.call<{ getLoginTokenFromCredentials: { loginToken: { token: string } } }>(host, `mutation($e:String!,$p:String!,$o:String!){ getLoginTokenFromCredentials(email:$e,password:$p,origin:$o){ loginToken{token} } }`, { e: email, p: password, o: host });
    const b = await this.call<{ getAuthTokensFromLoginToken: { tokens: { accessOrWorkspaceAgnosticToken: { token: string } } } }>(host, `mutation($t:String!,$o:String!){ getAuthTokensFromLoginToken(loginToken:$t,origin:$o){ tokens{accessOrWorkspaceAgnosticToken{token}} } }`, { t: a.getLoginTokenFromCredentials.loginToken.token, o: host });
    return b.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
  }

  /** Platform-account session for one workspace (host = that workspace's URL). */
  private async asPlatform(host: string): Promise<string> {
    const c = await this.platformCredentials();
    return this.login(host.replace(/\/$/, ''), c.email, c.password);
  }

  /** Host of a workspace subdomain on this instance: app.localhost:3020 → <sub>.localhost:3020. */
  private hostFor(subdomain: string): string {
    return this.base.replace(/\/\/[^.]+\./, `//${subdomain}.`);
  }

  async subdomainTaken(subdomain: string): Promise<boolean> {
    // An unknown subdomain answers "Workspace not found"; an existing one answers with a credentials error instead.
    const host = this.hostFor(subdomain);
    try {
      await this.call(host, `mutation($o:String!){ getLoginTokenFromCredentials(email:"nobody@invalid.example",password:"x",origin:$o){ loginToken{token} } }`, { o: host });
      return true;
    } catch (e) {
      return !/workspace not found/i.test((e as Error).message);
    }
  }

  async createWorkspace(input: { displayName: string; subdomain: string }): Promise<CreatedWorkspace> {
    const c = await this.platformCredentials();
    const agnostic = (await this.call<{ signIn: { tokens: { accessOrWorkspaceAgnosticToken: { token: string } } } }>(this.base, `mutation($e:String!,$p:String!){ signIn(email:$e,password:$p){ tokens{accessOrWorkspaceAgnosticToken{token}} } }`, { e: c.email, p: c.password })).signIn.tokens.accessOrWorkspaceAgnosticToken.token;
    const created = (await this.call<{ signUpInNewWorkspace: { workspace: { id: string; workspaceUrls: { subdomainUrl: string } } } }>(this.base, `mutation($i:SignUpInNewWorkspaceInput){ signUpInNewWorkspace(input:$i){ workspace{ id workspaceUrls{ subdomainUrl } } } }`, { i: { displayName: input.displayName } }, agnostic)).signUpInNewWorkspace.workspace;
    let host = created.workspaceUrls.subdomainUrl.replace(/\/$/, '');
    const token = await this.login(host, c.email, c.password);
    await this.call(host, `mutation($n:String!){ activateWorkspace(data:{displayName:$n}){ id } }`, { n: input.displayName }, token);
    // Public subdomain = the company's slug.
    await this.call(host, `mutation($d: UpdateWorkspaceInput!){ updateWorkspace(data:$d){ id } }`, { d: { subdomain: input.subdomain } }, token);
    host = host.replace(/\/\/[^.]+\./, `//${input.subdomain}.`);
    await this.warmUp(host);
    return { workspaceId: created.id, url: host, subdomain: input.subdomain };
  }

  /**
   * Ask for the workspace address once so its certificate (issued on demand by the front proxy) is ready before people
   * and Bee's runtime calls arrive. Best effort: provisioning does not depend on it.
   */
  private async warmUp(host: string): Promise<void> {
    if (!host.startsWith('https://')) return;
    for (let i = 0; i < 12; i++) {
      try {
        const r = await this.fetchFn(`${host}/healthz`, { signal: AbortSignal.timeout(15_000) });
        if (r.ok) return;
      } catch { /* certificate still being issued */ }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  async createApiKey(ws: CreatedWorkspace): Promise<string> {
    const token = await this.asPlatform(ws.url);
    const roles = (await this.call<{ getRoles: Array<{ id: string; label: string }> }>(ws.url, `{ getRoles { id label } }`, {}, token)).getRoles;
    const admin = roles.find((r) => r.label === 'Admin');
    if (!admin) throw new TwentyError('The workspace has no Admin role.');
    const exp = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const key = (await this.call<{ createApiKey: { id: string } }>(ws.url, `mutation($i:CreateApiKeyInput!){ createApiKey(input:$i){ id } }`, { i: { name: 'crm-bee-integration', expiresAt: exp, roleId: admin.id } }, token)).createApiKey;
    return (await this.call<{ generateApiKeyToken: { token: string } }>(ws.url, `mutation($id:UUID!,$e:String!){ generateApiKeyToken(apiKeyId:$id,expiresAt:$e){ token } }`, { id: key.id, e: exp }, token)).generateApiKeyToken.token;
  }

  async createServiceUser(ws: CreatedWorkspace, email: string, password: string): Promise<void> {
    const token = await this.asPlatform(ws.url);
    const hash = (await this.call<{ currentWorkspace: { inviteHash: string; id: string } }>(ws.url, `{ currentWorkspace { id inviteHash } }`, {}, token)).currentWorkspace;
    // The public invite link is open only for this sign-up and closed again immediately.
    await this.call(ws.url, `mutation($d: UpdateWorkspaceInput!){ updateWorkspace(data:$d){ id } }`, { d: { isPublicInviteLinkEnabled: true } }, token);
    try {
      await this.call(ws.url, `mutation($e:String!,$p:String!,$h:String,$w:UUID){ signUpInWorkspace(email:$e,password:$p,workspaceInviteHash:$h,workspaceId:$w){ loginToken{token} } }`, { e: email, p: password, h: hash.inviteHash, w: hash.id });
    } finally {
      await this.call(ws.url, `mutation($d: UpdateWorkspaceInput!){ updateWorkspace(data:$d){ id } }`, { d: { isPublicInviteLinkEnabled: false } }, token);
    }
    const roles = (await this.call<{ getRoles: Array<{ id: string; label: string; workspaceMembers: Array<{ id: string; userEmail: string }> }> }>(ws.url, `{ getRoles { id label workspaceMembers { id userEmail } } }`, {}, token)).getRoles;
    const adminRole = roles.find((r) => r.label === 'Admin')!;
    const member = roles.flatMap((r) => r.workspaceMembers).find((m) => m.userEmail?.toLowerCase() === email.toLowerCase());
    if (!member) throw new TwentyError('The service user did not join the workspace.');
    await this.call(ws.url, `mutation($m:UUID!,$r:UUID!){ updateWorkspaceMemberRole(workspaceMemberId:$m, roleId:$r){ id } }`, { m: member.id, r: adminRole.id }, token);
  }

  async installApp(ws: CreatedWorkspace, appUniversalId: string): Promise<void> {
    const token = await this.asPlatform(ws.url);
    await this.call(ws.url, `mutation($u:String!){ installApplication(universalIdentifier:$u){ id } }`, { u: appUniversalId }, token);
  }

  async removePlatformAccount(ws: CreatedWorkspace): Promise<boolean> {
    const c = await this.platformCredentials();
    const token = await this.login(ws.url, c.email, c.password).catch(() => null);
    if (!token) return true; // already gone
    const me = (await this.call<{ currentUser: { workspaceMember: { id: string } | null } }>(ws.url, `{ currentUser { workspaceMember { id } } }`, {}, token)).currentUser.workspaceMember;
    if (!me) return true;
    // Leaves THIS workspace only (the account keeps its membership of the platform workspace).
    await this.call(ws.url, `mutation($m:String!){ deleteUserFromWorkspace(workspaceMemberIdToDelete:$m){ id } }`, { m: me.id }, token);
    return true;
  }

  private get platformHost(): string {
    const u = this.config.platform.workspaceUrl;
    if (!u) throw new TwentyError('PLATFORM_WORKSPACE_URL is not configured.');
    return u.replace(/\/$/, '');
  }

  async listPlatformMembers(): Promise<Array<{ id: string; email: string | null }>> {
    const token = await this.asPlatform(this.platformHost);
    const roles = (await this.call<{ getRoles: Array<{ workspaceMembers: Array<{ id: string; userEmail: string | null }> }> }>(this.platformHost, `{ getRoles { workspaceMembers { id userEmail } } }`, {}, token)).getRoles;
    return roles.flatMap((r) => r.workspaceMembers).map((m) => ({ id: m.id, email: m.userEmail }));
  }

  async invitePlatformMember(email: string): Promise<{ sent: boolean; error?: string }> {
    try {
      const token = await this.asPlatform(this.platformHost);
      const roles = (await this.call<{ getRoles: Array<{ id: string; label: string }> }>(this.platformHost, `{ getRoles { id label } }`, {}, token)).getRoles;
      const member = roles.find((r) => r.label === 'Platform operator') ?? roles.find((r) => r.label === 'Member') ?? roles.find((r) => r.label !== 'Admin');
      const r = await this.call<{ sendInvitations: { success: boolean; errors: string[] } }>(this.platformHost, `mutation($e:[String!]!,$r:UUID){ sendInvitations(emails:$e, roleId:$r){ success errors } }`, { e: [email], r: member?.id ?? null }, token);
      return r.sendInvitations.success ? { sent: true } : { sent: false, error: r.sendInvitations.errors.join('; ') };
    } catch (e) {
      return { sent: false, error: (e as Error).message };
    }
  }
}
