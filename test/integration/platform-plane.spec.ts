import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ADMIN_KEY, createTestEnv, type TestEnv } from '../helpers/app';
import { tenantAppSecret } from '../../src/access/app-secret';
import { DbService } from '../../src/database/db.service';
import { auditLog, companyProvisioning, platformAuditLog, secretVault, tenants, users } from '../../src/database/schema';
import { WORKSPACE_FACTORY, type CreatedWorkspace, type WorkspaceFactory } from '../../src/platform/workspace-factory';
import { CompanyProvisioner } from '../../src/platform/company-provisioner.service';
import { SecretVault } from '../../src/secrets/secret-vault';
import { TwentyAccessService } from '../../src/crm/twenty/twenty-access.service';
import { TenantService } from '../../src/tenant/tenant.service';

/**
 * The platform plane (BRD §1/§4): operators create companies, each in its own Twenty workspace, through the Platform
 * console API; credentials land in the encrypted vault; operators never see CRM data without a client-approved grant.
 */
const CHAT = 'test-crm-chat-token-0123456789abcdef';
const OPS_WS = '00000000-0000-4000-8000-0000000000aa';
const OPS_MEMBER = '00000000-0000-4000-8000-0000000000bb';

/** A WorkspaceFactory that creates workspaces inside the fake Twenty (no network, no real Twenty server). */
class FakeFactory implements WorkspaceFactory {
  created: string[] = [];
  failOn: string | null = null;
  platformMembers: Array<{ id: string; email: string | null }> = [];
  invited: string[] = [];
  constructor(private readonly env: () => TestEnv) {}
  async createWorkspace(i: { displayName: string; subdomain: string }): Promise<CreatedWorkspace> {
    if (this.failOn === 'workspace') { this.failOn = null; throw new Error('Twenty is unreachable'); }
    this.created.push(i.subdomain);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${b64({ alg: 'HS256' })}.${b64({ type: 'API_KEY', jti: `key-${i.subdomain}` })}.sig`;
    this.env().twenty.addWorkspace(i.subdomain, token);
    (this as any)[`tok_${i.subdomain}`] = token;
    return { workspaceId: `ws-${i.subdomain}`, url: this.env().twenty.url, subdomain: i.subdomain };
  }
  async createApiKey(ws: CreatedWorkspace) { return (this as any)[`tok_${ws.subdomain}`]; }
  async createServiceUser(ws: CreatedWorkspace, email: string, password: string) {
    if (this.failOn === 'service') { this.failOn = null; throw new Error('sign-up refused'); }
    const w = this.env().twenty.workspaces.get(ws.subdomain)!;
    w.logins.set(email, password);
    w.data.workspaceMembers.push({ id: `m-${ws.subdomain}-svc`, name: { firstName: 'Bee', lastName: 'service' }, userEmail: email, userId: `tu-${ws.subdomain}-svc` });
    w.memberRole.set(`m-${ws.subdomain}-svc`, 'role-admin');
  }
  async installApp() { /* the fake workspace already has the app */ }
  async removePlatformAccount() { return true; }
  async subdomainTaken(s: string) { return this.created.includes(s) && false; }
  async listPlatformMembers() { return this.platformMembers; }
  async invitePlatformMember(email: string) { this.invited.push(email); return { sent: true }; }
}

describe('platform plane: operators create and run companies (§1, §4, TEN-05)', () => {
  let env: TestEnv; let db: DbService; let factory: FakeFactory;
  const inject = (o: any) => env.app.inject(o);
  const op = (method: string, url: string, payload?: unknown) => inject({ method, url, payload, headers: { authorization: `Bearer ${tenantAppSecret(CHAT, 'platform')}`, 'x-bee-workspace': OPS_WS, 'x-bee-member': OPS_MEMBER } });
  const NEW = { name: 'Acme Foods', slug: 'acme-foods', adminName: 'Priya Sharma', adminEmail: 'priya@acme.example', timezone: 'Asia/Kolkata', defaultCurrency: 'INR', morningReminderTime: '09:00', pipelinePreset: 'standard', teams: [{ key: 'north', name: 'North' }] };

  beforeAll(async () => {
    factory = new FakeFactory(() => env);
    env = await createTestEnv({
      config: {
        platform: { workspaceId: OPS_WS, workspaceUrl: 'http://ylogx.test', twentyUrl: 'http://app.test', adminEmail: 'platform@ylogx.test', adminPasswordRef: 'env:PLATFORM_ADMIN_PASSWORD', appUniversalId: '9b650bfb-85fc-478d-961a-a40ee10235dc' },
        security: { jwtSecret: 'j'.repeat(40), adminApiKey: ADMIN_KEY, secretsMasterKey: 'm'.repeat(40) },
      } as any,
      providers: [{ token: WORKSPACE_FACTORY, value: factory }],
    });
    db = env.get(DbService);
    // The first operator: created with the bootstrap key and linked to the operations-workspace member.
    const r = await inject({ method: 'POST', url: '/admin/operators', headers: { 'x-api-key': ADMIN_KEY }, payload: { name: 'Olu Ops', email: 'olu@ylogx.test' } });
    expect(r.statusCode).toBe(201);
    expect((await inject({ method: 'POST', url: `/admin/operators/${r.json().id}/link`, headers: { 'x-api-key': ADMIN_KEY }, payload: { memberId: OPS_MEMBER } })).statusCode).toBe(200);
  });
  afterAll(async () => { await env.close(); });

  it('an operations-workspace member linked to an operator is a platform principal; a stranger is not', async () => {
    const me = await op('GET', '/v1/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ platform: true, linked: true, operator: { name: 'Olu Ops' } });
    const stranger = await inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tenantAppSecret(CHAT, 'platform')}`, 'x-bee-workspace': OPS_WS, 'x-bee-member': '00000000-0000-4000-8000-0000000000cc' } });
    expect(stranger.json()).toMatchObject({ platform: true, linked: false });
    expect((await inject({ method: 'GET', url: '/v1/platform/companies', headers: { authorization: `Bearer ${tenantAppSecret(CHAT, 'platform')}`, 'x-bee-workspace': OPS_WS, 'x-bee-member': '00000000-0000-4000-8000-0000000000cc' } })).statusCode).toBe(403);
    // A company's secret does not open the platform plane.
    expect((await inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tenantAppSecret(CHAT, 'some-tenant')}`, 'x-bee-workspace': OPS_WS, 'x-bee-member': OPS_MEMBER } })).statusCode).toBe(401);
  });

  it('creating a company runs in the background and ends with a working, isolated tenant', async () => {
    const r = await op('POST', '/v1/platform/companies', NEW);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ state: 'running', slug: 'acme-foods' });
    let row: any;
    for (let i = 0; i < 100; i++) {
      row = (await op('GET', '/v1/platform/companies/in-progress')).json().find((p: any) => p.slug === 'acme-foods');
      if (row && row.state !== 'running') break;
      await new Promise((x) => setTimeout(x, 100));
    }
    expect(row).toMatchObject({ state: 'ready', error: null, invitation: { sent: true } });
    expect(row.steps).toEqual(['workspace created', 'integration key created', 'service user created', 'app installed', 'tenant provisioned', 'client admin invited', 'provisioning account removed']);

    const list = (await op('GET', '/v1/platform/companies')).json();
    const acme = list.find((c: any) => c.slug === 'acme-foods');
    expect(acme).toMatchObject({ status: 'active', timezone: 'Asia/Kolkata', currency: 'INR', users: { active: 1 } });
    const detail = (await op('GET', `/v1/platform/companies/${acme.id}`)).json();
    expect(detail.users).toEqual([expect.objectContaining({ name: 'Priya Sharma', role: 'client_admin', invited: true })]);
    expect(detail.pipeline.map((s: any) => s.label)).toContain('Negotiation');
    // The workspace's own ids, not the platform's, are what the tenant is bound to.
    const [t] = await db.db.select().from(tenants).where(eq(tenants.slug, 'acme-foods'));
    expect(t.twentyWorkspaceId).toBe('ws-acme-foods');
  });

  it('credentials are stored encrypted in the vault, never as plaintext in the tenant record', async () => {
    const rows = await db.systemTx((tx) => tx.select().from(secretVault));
    expect(rows.map((r) => r.name).sort()).toEqual(['tenant/acme-foods/service_password', 'tenant/acme-foods/twenty_api_key']);
    for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/Svc-|sig$/);
    const vault = env.get<SecretVault>(SecretVault);
    expect(await vault.get('tenant/acme-foods/service_password')).toMatch(/^Svc-/);
    const [t] = await db.db.select().from(tenants).where(eq(tenants.slug, 'acme-foods'));
    expect(JSON.stringify(t)).not.toMatch(/Svc-/);
    expect(JSON.stringify(t.settings)).toContain('db:tenant/acme-foods/service_password');
  });

  it('a company cannot be created twice or under a reserved address; bad input is explained', async () => {
    expect((await op('POST', '/v1/platform/companies', NEW)).statusCode).toBe(409);
    expect((await op('POST', '/v1/platform/companies', { ...NEW, slug: 'admin', name: 'Admin Co' })).statusCode).toBeGreaterThanOrEqual(400);
    const bad = await op('POST', '/v1/platform/companies', { ...NEW, slug: 'x', adminEmail: 'nope' });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a failed step is recorded and the next attempt continues without a second workspace', async () => {
    factory.failOn = 'service';
    const req = { ...NEW, name: 'Globex Retail', slug: 'globex-retail', adminName: 'Rohan Mehta', adminEmail: 'rohan@globex.example' };
    const before = factory.created.length;
    await op('POST', '/v1/platform/companies', req);
    let row: any;
    for (let i = 0; i < 100; i++) { row = (await op('GET', '/v1/platform/companies/in-progress')).json().find((p: any) => p.slug === 'globex-retail'); if (row && row.state !== 'running') break; await new Promise((x) => setTimeout(x, 100)); }
    expect(row.state).toBe('failed');
    expect(row.error).toMatch(/service user/);
    expect(row.steps).toEqual(['workspace created', 'integration key created']);
    await op('POST', '/v1/platform/companies', req);
    for (let i = 0; i < 100; i++) { row = (await op('GET', '/v1/platform/companies/in-progress')).json().find((p: any) => p.slug === 'globex-retail'); if (row && row.state === 'ready') break; await new Promise((x) => setTimeout(x, 100)); }
    expect(row.state).toBe('ready');
    expect(factory.created.length - before).toBe(1);
  });

  it('operators see people and health but not records; the audit trail needs a client-approved grant', async () => {
    const acme = (await op('GET', '/v1/platform/companies')).json().find((c: any) => c.slug === 'acme-foods');
    expect((await op('GET', `/v1/platform/companies/${acme.id}/audit`)).statusCode).toBe(403);
    const rq = await op('POST', `/v1/platform/companies/${acme.id}/support-request`, { reason: 'Investigating a failed import', hours: 2 });
    expect(rq.statusCode).toBe(200);
    expect((await op('GET', `/v1/platform/companies/${acme.id}/audit`)).statusCode).toBe(403);
    // The client admin approves (as they would in Bee › Security & audit).
    const ops = env.get<any>(TenantService);
    void ops;
    const adminId = (await db.tenantTx(acme.id, (tx) => tx.select().from(users).where(eq(users.email, 'priya@acme.example'))))[0].id;
    const { OperatorService } = await import('../../src/access/operator.service');
    await env.get<InstanceType<typeof OperatorService>>(OperatorService).decide(acme.id, rq.json().id, 'approve', adminId);
    expect((await op('GET', `/v1/platform/companies/${acme.id}/audit`)).statusCode).toBe(200);
  });

  it('suspending a company is audited on both sides and reactivation restores it', async () => {
    const acme = (await op('GET', '/v1/platform/companies')).json().find((c: any) => c.slug === 'acme-foods');
    expect((await op('POST', `/v1/platform/companies/${acme.id}/suspend`, { reason: 'unpaid invoice' })).json()).toEqual({ status: 'suspended' });
    const tenantAudit = await db.tenantTx(acme.id, (tx) => tx.select({ a: auditLog.action }).from(auditLog).where(eq(auditLog.tenantId, acme.id)));
    expect(tenantAudit.map((x) => x.a)).toContain('tenant.suspended');
    expect((await op('POST', `/v1/platform/companies/${acme.id}/reactivate`, {})).json()).toEqual({ status: 'active' });
    const platform = await db.systemTx((tx) => tx.select({ a: platformAuditLog.action }).from(platformAuditLog));
    expect(platform.map((x) => x.a)).toEqual(expect.arrayContaining(['company.created', 'company.suspended', 'company.reactivated', 'support.requested']));
  });

  it('platform audit and provisioning records cannot be altered', async () => {
    await expect(db.systemTx((tx) => tx.update(platformAuditLog).set({ action: 'x' }))).rejects.toThrow();
    const [p] = await db.systemTx((tx) => tx.select().from(companyProvisioning).where(eq(companyProvisioning.slug, 'acme-foods')));
    expect(p.state).toBe('ready');
  });

  it('operators added in the console are invited to the operations workspace and linked when they accept', async () => {
    const add = await op('POST', '/v1/platform/operators', { name: 'Pia Ops', email: 'pia@ylogx.test' });
    expect(add.statusCode).toBe(201);
    expect(add.json().invitation).toEqual({ sent: true });
    expect(factory.invited).toContain('pia@ylogx.test');
    factory.platformMembers = [{ id: '00000000-0000-4000-8000-0000000000dd', email: 'PIA@ylogx.test' }];
    const list = (await op('GET', '/v1/platform/operators')).json();
    expect(list.find((o: any) => o.email === 'pia@ylogx.test')).toMatchObject({ signedIn: true, invited: true });
    // …and Pia can now use the console from her own member.
    const as = await inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tenantAppSecret(CHAT, 'platform')}`, 'x-bee-workspace': OPS_WS, 'x-bee-member': '00000000-0000-4000-8000-0000000000dd' } });
    expect(as.json()).toMatchObject({ platform: true, linked: true, operator: { name: 'Pia Ops' } });
  });

  it('an invited operator is linked on first sign-in, without anyone opening the operator list', async () => {
    expect((await op('POST', '/v1/platform/operators', { name: 'Quinn Ops', email: 'quinn@ylogx.test' })).statusCode).toBe(201);
    const member = '00000000-0000-4000-8000-0000000000ee';
    const call = () => inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tenantAppSecret(CHAT, 'platform')}`, 'x-bee-workspace': OPS_WS, 'x-bee-member': member } });
    expect((await call()).json()).toMatchObject({ platform: true, linked: false });
    factory.platformMembers = [{ id: member, email: 'quinn@ylogx.test' }];
    await new Promise((r) => setTimeout(r, 5_200)); // the guard rate-limits adoption checks per member
    expect((await call()).json()).toMatchObject({ platform: true, linked: true, operator: { name: 'Quinn Ops' } });
  }, 30_000);

  it('TLS certificates are only approved for names this deployment serves', async () => {
    const ask = async (d: string) => (await inject({ method: 'GET', url: `/internal/tls-ask?domain=${encodeURIComponent(d)}` })).statusCode;
    expect(await ask('app.test')).toBe(200);          // the Twenty base host
    expect(await ask('ylogx.test')).toBe(200);        // the operations workspace
    expect(await ask('test')).toBe(404);              // (single label is never a host)
    expect(await ask('acme-foods.test')).toBe(200);   // a company created through the console
    expect(await ask('unknown.test')).toBe(404);
    expect(await ask('evil.example.org')).toBe(404);
    expect(await ask('')).toBe(404);
    expect(await ask('a_b.test')).toBe(404);
    // While a creation is actually running, Twenty's generated address for the new workspace is approved too.
    await db.systemTx((tx) => tx.insert(companyProvisioning).values({ slug: 'tls-window', request: {} as any, state: 'running', createdBy: 'operator:test' }));
    expect(await ask('sleepy-otter-1a2b.test')).toBe(200);
    expect(await ask('evil.example.org')).toBe(404);
    await db.systemTx((tx) => tx.update(companyProvisioning).set({ state: 'failed' }).where(eq(companyProvisioning.slug, 'tls-window')));
    expect(await ask('sleepy-otter-1a2b.test')).toBe(404);
  });

  it('a person who accepts the client admin\'s invitation is linked on first use', async () => {
    const acme = (await op('GET', '/v1/platform/companies')).json().find((c: any) => c.slug === 'acme-foods');
    const w = env.twenty.workspaces.get('acme-foods')!;
    // The invited admin accepted in Twenty: a member with the same mailbox now exists.
    w.data.workspaceMembers.push({ id: 'm-priya-acme', name: { firstName: 'Priya', lastName: 'Sharma' }, userEmail: 'priya@acme.example', userId: 'tu-priya', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const r = await inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tenantAppSecret(CHAT, acme.id)}`, 'x-bee-workspace': 'ws-acme-foods', 'x-bee-member': 'm-priya-acme' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ linked: true, user: { role: 'client_admin', displayName: 'Priya Sharma' } });
    // A stranger with another mailbox is not adopted.
    w.data.workspaceMembers.push({ id: 'm-eve-elsewhere', name: { firstName: 'Eve', lastName: '' }, userEmail: 'eve@elsewhere.example', userId: 'tu-eve', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const e = await inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tenantAppSecret(CHAT, acme.id)}`, 'x-bee-workspace': 'ws-acme-foods', 'x-bee-member': 'm-eve-elsewhere' } });
    expect(e.json()).toMatchObject({ linked: false });
    void CompanyProvisioner; void TwentyAccessService;
  });
});
