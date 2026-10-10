import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestEnv, type TestEnv } from '../helpers/app';
import { jwtFor, seedTenant, type SeededTenant } from '../helpers/fixtures';
import { DbService } from '../../src/database/db.service';
import { users } from '../../src/database/schema';
import { TenantService } from '../../src/tenant/tenant.service';
import { TwentyAccessService } from '../../src/crm/twenty/twenty-access.service';

/**
 * Bee ↔ Twenty native access (§4, IAM-01, IAM-05, Integration Service Identity): Bee-managed roles, hardened
 * workspace settings, member role assignment, the integration key's role, invitations and automatic linking.
 */
describe('Twenty access sync, integration identity and invitations', () => {
  let env: TestEnv; let T: SeededTenant; let db: DbService;
  const ws = () => env.twenty.workspaces.get(T.slug)!;
  const roleOf = (memberId: string) => { const id = ws().memberRole.get(memberId) ?? ws().settings.defaultRoleId; return ws().roles.find((r) => r.id === id)?.label; };
  const tenant = () => env.get(TenantService).getContext(T.tenantId);
  const sync = async () => env.get(TwentyAccessService).sync(await tenant());
  const inject = (o: any) => env.app.inject(o);
  const asAdmin = (method: string, url: string, payload?: unknown) => inject({ method, url, payload, headers: { authorization: `Bearer ${jwtFor(T, 'ada')}` } });

  beforeAll(async () => {
    env = await createTestEnv();
    T = await seedTenant(env, { slug: 'acc-sync', serviceUser: true, users: [
      { key: 'ada', displayName: 'Ada Admin', role: 'client_admin' },
      { key: 'sam', displayName: 'Sam Seller', role: 'salesperson', teamId: 'north' },
      { key: 'meera', displayName: 'Meera Manager', role: 'manager', teamId: 'north', managedTeamIds: ['north'] },
      { key: 'cleo', displayName: 'Cleo CXO', role: 'cxo' },
    ] });
    db = env.get(DbService);
  });
  afterAll(async () => { await env.close(); });

  it('creates the Bee roles, hardens the workspace and maps every linked member (provisioning ran the sync)', async () => {
    const labels = ws().roles.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(['Bee · No access', 'Bee · Salesperson', 'Bee · Manager', 'Bee · CXO', 'Bee · Integration']));
    expect(ws().settings.isPublicInviteLinkEnabled).toBe(false);
    expect(ws().settings.allowImpersonation).toBe(false);
    expect(ws().roles.find((r) => r.id === ws().settings.defaultRoleId)?.label).toBe('Bee · No access');
    expect(roleOf(T.users.sam.memberId)).toBe('Bee · Salesperson');
    expect(roleOf(T.users.meera.memberId)).toBe('Bee · Manager');
    expect(roleOf(T.users.cleo.memberId)).toBe('Bee · CXO');
    expect(roleOf(T.users.ada.memberId)).toBe('Admin');
    // the service user keeps its Admin seat and is not an employee
    expect(roleOf(`m-${T.slug}-svc`)).toBe('Admin');
  });

  it('salesperson and manager roles have no record access; CXO cannot destroy; nobody but Admin can', async () => {
    const r = (l: string) => ws().roles.find((x) => x.label === l)!;
    for (const l of ['Bee · Salesperson', 'Bee · Manager']) expect(r(l)).toMatchObject({ canReadAllObjectRecords: false, canUpdateAllObjectRecords: false, canSoftDeleteAllObjectRecords: false, canDestroyAllObjectRecords: false });
    expect(r('Bee · CXO')).toMatchObject({ canReadAllObjectRecords: true, canUpdateAllObjectRecords: true, canDestroyAllObjectRecords: false });
    expect(r('Bee · No access')).toMatchObject({ canReadAllObjectRecords: false, canUpdateAllSettings: false });
  });

  it('the integration key is not an administrator: a dedicated role without destroy, roles or settings', async () => {
    const role = ws().roles.find((x) => x.label === 'Bee · Integration')!;
    expect(role).toMatchObject({ canReadAllObjectRecords: true, canUpdateAllObjectRecords: true, canSoftDeleteAllObjectRecords: true, canDestroyAllObjectRecords: false, canUpdateAllSettings: false });
    expect(role.permissionFlags.map((f: any) => f.flag)).toEqual(['DATA_MODEL']);
    expect(ws().apiKeys[0].roleId).toBe(role.id);
    // and with that role the key can still read/write records and provision schema, but cannot manage roles
    const rep = await sync();
    expect(rep.ok).toBe(true);
    expect(rep.integrationRole).toMatchObject({ role: 'Bee · Integration', changed: false });
  });

  it('is idempotent: a second sync changes nothing', async () => {
    const rep = await sync();
    expect(rep).toMatchObject({ ok: true, rolesCreated: [], rolesUpdated: [], workspaceSettingsChanged: [], memberChanges: [], drift: [] });
  });

  it('re-applies roles after a change or revocation in Bee, and reverts native drift (IAM-05)', async () => {
    expect((await asAdmin('PATCH', `/v1/tenant-admin/users/${T.users.sam.id}`, { role: 'manager', managedTeamIds: ['north'] })).statusCode).toBe(200);
    expect((await sync()).ok).toBe(true);
    expect(roleOf(T.users.sam.memberId)).toBe('Bee · Manager');
    // someone promotes Sam to Admin directly in Twenty: the next sync puts him back and reports it
    ws().memberRole.set(T.users.sam.memberId, 'role-admin');
    const rep = await sync();
    expect(rep.memberChanges.map((c: { to: string }) => c.to)).toContain('Bee · Manager');
    expect(roleOf(T.users.sam.memberId)).toBe('Bee · Manager');
    // revocation removes native access too
    expect((await asAdmin('POST', `/v1/tenant-admin/users/${T.users.sam.id}/revoke`)).statusCode).toBe(200);
    await sync();
    expect(roleOf(T.users.sam.memberId)).toBe('Bee · No access');
  });

  it('never strips the last Admin seat and never touches the service user', async () => {
    const rep = await sync();
    expect(roleOf(`m-${T.slug}-svc`)).toBe('Admin');
    expect(rep.memberChanges.some((c: { email: string | null }) => c.email?.startsWith('bee-service@'))).toBe(false);
  });

  describe('invitations (IAM-01) and linking', () => {
    it('Add user invites the e-mail into Twenty as "No access"; accepting links the member automatically', async () => {
      const r = await asAdmin('POST', '/v1/tenant-admin/users', { displayName: 'Nina North', email: 'nina@acc-sync.test', role: 'salesperson', teamId: 'north' });
      expect(r.statusCode).toBe(201);
      expect(r.json().invitation).toEqual({ sent: true });
      expect(ws().invitations).toContain('nina@acc-sync.test');
      const id = r.json().id as string;
      // nothing is linked yet; an e-mail twin that nobody invited through Bee must stay unlinked
      expect((await db.tenantTx(T.tenantId, (tx) => tx.select().from(users).where(eq(users.id, id))))[0].twentyMemberId).toBeNull();
      ws().data.workspaceMembers.push({ id: 'm-nina', userEmail: 'nina@acc-sync.test', name: { firstName: 'Nina', lastName: '' }, userId: 'tu-nina' });
      ws().data.workspaceMembers.push({ id: 'm-stranger', userEmail: 'stranger@acc-sync.test', name: { firstName: 'Stranger', lastName: '' }, userId: 'tu-stranger' });
      const rep = await sync();
      expect(rep.autoLinked).toEqual(['nina@acc-sync.test']);
      const [row] = await db.tenantTx(T.tenantId, (tx) => tx.select().from(users).where(eq(users.id, id)));
      expect(row.twentyMemberId).toBe('m-nina');
      expect(roleOf('m-nina')).toBe('Bee · Salesperson');
      expect(roleOf('m-stranger')).toBe('Bee · No access'); // unknown member: no access, reported as drift
      expect(rep.drift.join(' ')).toMatch(/stranger@acc-sync.test is a Twenty member without a linked Bee user/);
    });

    it('a user who was never invited through Bee is NOT linked by e-mail match alone', async () => {
      const r = await asAdmin('POST', '/v1/tenant-admin/users', { displayName: 'Oli Outside', email: 'oli@acc-sync.test', role: 'salesperson', teamId: 'north', invite: false });
      expect(r.statusCode).toBe(201);
      ws().data.workspaceMembers.push({ id: 'm-oli', userEmail: 'oli@acc-sync.test', name: { firstName: 'Oli', lastName: '' }, userId: 'tu-oli' });
      const rep = await sync();
      expect(rep.autoLinked ?? []).not.toContain('oli@acc-sync.test');
      const [row] = await db.tenantTx(T.tenantId, (tx) => tx.select().from(users).where(eq(users.id, r.json().id)));
      expect(row.twentyMemberId).toBeNull();
      // the admin sees it only as a suggestion
      const m = (await asAdmin('GET', '/v1/tenant-admin/members')).json();
      expect(m.find((x: any) => x.id === 'm-oli')).toMatchObject({ linkedUserId: null, suggestedUserId: r.json().id });
    });

    it("Bee's own service account is not listed as an employee and cannot be linked to one", async () => {
      const m = (await asAdmin('GET', '/v1/tenant-admin/members')).json();
      expect(m.some((x: any) => x.email?.startsWith('bee-service@'))).toBe(false);
      const res = await asAdmin('POST', `/v1/tenant-admin/users/${T.users.cleo.id}/link`, { memberId: `m-${T.slug}-svc` });
      expect(res.statusCode).toBe(409);
    });
  });

  it('configures the CRM Bee app in the workspace with THIS tenant\'s secret and Bee URL', async () => {
    const rep = await env.get(TwentyAccessService).configureApp(await tenant(), { BEE_CHAT_TOKEN: 'x'.repeat(40) });
    expect(rep).toEqual({ configured: true });
    expect(ws().appVariables.BEE_CHAT_TOKEN).toHaveLength(40);
  });
});
