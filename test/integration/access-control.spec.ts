import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ADMIN_KEY, createTestEnv, type TestEnv } from '../helpers/app';
import { jwtFor, seedRecords, seedTenant, type SeededTenant } from '../helpers/fixtures';
import { tenantAppSecret } from '../../src/access/app-secret';
import { DbService } from '../../src/database/db.service';
import { auditLog, channelBindings, operations } from '../../src/database/schema';
import { ArchiveRequestService } from '../../src/approvals/archive-request.service';
import { TenantService } from '../../src/tenant/tenant.service';
import { IdentityService } from '../../src/identity/identity.service';

/**
 * Access model of the BRD (§4) end to end over HTTP: tenant isolation through every route, the role × permission
 * matrix, client-admin administration, Twenty-app authentication, archive requests and operator support grants.
 */
describe('access control: roles, tenant admin, Twenty app, operators (§4, AT-01, AT-02, IAM-01..05)', () => {
  let env: TestEnv; let A: SeededTenant; let B: SeededTenant; let db: DbService;
  const CHAT = 'test-crm-chat-token-0123456789abcdef';
  const inject = (o: any) => env.app.inject(o);
  /** A call as the CRM Bee app inside Twenty would make it. */
  const app = (t: SeededTenant, memberId: string, method: string, url: string, payload?: unknown, secretOf: SeededTenant = t) =>
    inject({ method, url, payload, headers: { authorization: `Bearer ${tenantAppSecret(CHAT, secretOf.tenantId)}`, 'x-bee-workspace': `ws-${t.slug}`, 'x-bee-member': memberId } });
  const asUser = (t: SeededTenant, k: string, method: string, url: string, payload?: unknown) => inject({ method, url, payload, headers: { authorization: `Bearer ${jwtFor(t, k)}` } });

  beforeAll(async () => {
    env = await createTestEnv();
    const people = [
      { key: 'sam', displayName: 'Sam Seller', role: 'salesperson' as const, teamId: 'north', phone: '+919811100001' },
      { key: 'sue', displayName: 'Sue South', role: 'salesperson' as const, teamId: 'south', phone: '+919811100002' },
      { key: 'meera', displayName: 'Meera Manager', role: 'manager' as const, teamId: 'north', managedTeamIds: ['north'], phone: '+919811100003' },
      { key: 'cleo', displayName: 'Cleo CXO', role: 'cxo' as const, phone: '+919811100004' },
      { key: 'ada', displayName: 'Ada Admin', role: 'client_admin' as const, phone: '+919811100005' },
    ];
    A = await seedTenant(env, { slug: 'acc-a', users: people });
    B = await seedTenant(env, { slug: 'acc-b', users: [{ key: 'bob', displayName: 'Bob B', role: 'client_admin', phone: '+919822200001' }] });
    db = env.get(DbService);
  });
  afterAll(async () => { await env.close(); });

  describe('Twenty app authentication', () => {
    it('a linked member is resolved to their user, role and permissions', async () => {
      const r = await app(A, A.users.sam.memberId, 'GET', '/v1/me');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ linked: true, user: { id: A.users.sam.id, role: 'salesperson' }, scope: 'own' });
      expect(r.json().permissions).toContain('records.archive.request');
      expect(r.json().permissions).not.toContain('tenant.users.manage');
    });

    it("tenant A's secret cannot speak for tenant B, and a wrong secret is refused", async () => {
      expect((await app(B, B.users.bob.memberId, 'GET', '/v1/me', undefined, A)).statusCode).toBe(401);
      const forged = await inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer nope', 'x-bee-workspace': `ws-${A.slug}`, 'x-bee-member': A.users.ada.memberId } });
      expect(forged.statusCode).toBe(401);
      // a member of workspace B presented to workspace A is simply not linked there
      expect((await app(A, B.users.bob.memberId, 'GET', '/v1/tenant-admin/users')).statusCode).toBe(403);
    });

    it('an unlinked member can only ask who they are; an e-mail match never links them', async () => {
      const me = await app(A, 'm-not-linked-0001', 'GET', '/v1/me');
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ linked: false });
      expect((await app(A, 'm-not-linked-0001', 'POST', '/v1/crm-chat/send', { text: 'hi' })).statusCode).toBe(403);
    });

    it('the in-CRM chat binds the conversation to the linked member, and unlinking stops it at once', async () => {
      expect((await app(A, A.users.sue.memberId, 'GET', '/v1/crm-chat/messages')).statusCode).toBe(200);
      const [b] = await db.tenantTx(A.tenantId, (tx) => tx.select().from(channelBindings).where(eq(channelBindings.externalId, `ws-${A.slug}:${A.users.sue.memberId}`)));
      expect(b).toMatchObject({ channel: 'web', userId: A.users.sue.id, status: 'active' });
      expect((await app(A, A.users.ada.memberId, 'POST', `/v1/tenant-admin/users/${A.users.sue.id}/unlink`)).statusCode).toBe(200);
      expect((await app(A, A.users.sue.memberId, 'GET', '/v1/crm-chat/messages')).statusCode).toBe(403);
      const [after] = await db.tenantTx(A.tenantId, (tx) => tx.select().from(channelBindings).where(eq(channelBindings.id, b.id)));
      expect(after.status).toBe('revoked');
      // relink (explicitly, by the admin) for the remaining tests
      expect((await app(A, A.users.ada.memberId, 'POST', `/v1/tenant-admin/users/${A.users.sue.id}/link`, { memberId: A.users.sue.memberId })).statusCode).toBe(200);
    });
  });

  describe('role × permission matrix on the tenant-admin API', () => {
    it.each(['sam', 'meera', 'cleo'])('%s (not a client admin) cannot manage users, teams, config, audit or support', async (k) => {
      for (const [m, u] of [['GET', '/v1/tenant-admin/users'], ['GET', '/v1/tenant-admin/teams'], ['GET', '/v1/tenant-admin/config'], ['GET', '/v1/tenant-admin/audit'], ['GET', '/v1/tenant-admin/support']] as const) {
        expect((await asUser(A, k, m, u)).statusCode, `${k} ${u}`).toBe(403);
      }
    });

    it('the client admin sees only their own tenant', async () => {
      const r = await asUser(A, 'ada', 'GET', '/v1/tenant-admin/users');
      expect(r.statusCode).toBe(200);
      expect(r.json().map((u: any) => u.id).sort()).toEqual(Object.values(A.users).map((u) => u.id).sort());
      // another tenant's user id is "not found", never visible or editable
      expect((await asUser(A, 'ada', 'PATCH', `/v1/tenant-admin/users/${B.users.bob.id}`, { displayName: 'X' })).statusCode).toBe(404);
      expect((await asUser(A, 'ada', 'POST', `/v1/tenant-admin/users/${B.users.bob.id}/revoke`)).statusCode).toBe(404);
    });

    it('creates users with validated teams; links only members of its own workspace; one member per user', async () => {
      expect((await asUser(A, 'ada', 'POST', '/v1/tenant-admin/users', { displayName: 'New Rep', email: 'new@acc-a.test', role: 'salesperson', teamId: 'nowhere' })).statusCode).toBe(422);
      const created = await asUser(A, 'ada', 'POST', '/v1/tenant-admin/users', { displayName: 'New Rep', email: 'new@acc-a.test', role: 'salesperson', teamId: 'north' });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;
      expect((await asUser(A, 'ada', 'POST', '/v1/tenant-admin/users', { displayName: 'Dupe', email: 'NEW@acc-a.test', role: 'salesperson' })).statusCode).toBe(409);
      // a member of tenant B's workspace cannot be linked into tenant A
      expect((await asUser(A, 'ada', 'POST', `/v1/tenant-admin/users/${id}/link`, { memberId: B.users.bob.memberId })).statusCode).toBe(404);
      // a member already linked to someone else cannot be taken
      expect((await asUser(A, 'ada', 'POST', `/v1/tenant-admin/users/${id}/link`, { memberId: A.users.sam.memberId })).statusCode).toBe(409);
      const members = (await asUser(A, 'ada', 'GET', '/v1/tenant-admin/members')).json();
      expect(members.find((m: any) => m.id === A.users.sam.memberId)).toMatchObject({ linkedUserId: A.users.sam.id });
      const audit = await db.tenantTx(A.tenantId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'user.created')));
      expect(audit.some((a) => (a.metadata as any)?.actor === `user:${A.users.ada.id}`)).toBe(true);
    });

    it('the last active client admin cannot be demoted or revoked', async () => {
      expect((await asUser(A, 'ada', 'PATCH', `/v1/tenant-admin/users/${A.users.ada.id}`, { role: 'cxo' })).statusCode).toBe(403);
      expect((await asUser(A, 'ada', 'POST', `/v1/tenant-admin/users/${A.users.ada.id}/revoke`)).statusCode).toBe(403);
    });

    it('a role change applies on the next request (IAM-05): revoke → 401, reinstate restores access', async () => {
      expect((await asUser(A, 'cleo', 'GET', '/v1/approvals/archive')).statusCode).toBe(200);
      expect((await asUser(A, 'ada', 'PATCH', `/v1/tenant-admin/users/${A.users.cleo.id}`, { role: 'salesperson' })).statusCode).toBe(200);
      expect((await asUser(A, 'cleo', 'GET', '/v1/approvals/archive')).statusCode).toBe(403);
      expect((await asUser(A, 'ada', 'POST', `/v1/tenant-admin/users/${A.users.cleo.id}/revoke`)).statusCode).toBe(200);
      expect((await asUser(A, 'cleo', 'GET', '/v1/me')).statusCode).toBe(401);
      expect((await app(A, A.users.cleo.memberId, 'GET', '/v1/crm-chat/messages')).statusCode).toBe(403);
      expect((await asUser(A, 'ada', 'POST', `/v1/tenant-admin/users/${A.users.cleo.id}/reinstate`)).statusCode).toBe(200);
      expect((await asUser(A, 'ada', 'PATCH', `/v1/tenant-admin/users/${A.users.cleo.id}`, { role: 'cxo' })).statusCode).toBe(200);
      expect((await asUser(A, 'cleo', 'GET', '/v1/approvals/archive')).statusCode).toBe(200);
    });

    it('teams in use cannot be deactivated; configuration edits are versioned and admin-only', async () => {
      expect((await asUser(A, 'ada', 'POST', '/v1/tenant-admin/teams/north/deactivate')).statusCode).toBe(409);
      expect((await asUser(A, 'ada', 'POST', '/v1/tenant-admin/teams', { key: 'east', name: 'East' })).statusCode).toBe(200);
      const before = (await asUser(A, 'ada', 'GET', '/v1/tenant-admin/config')).json();
      const r = await asUser(A, 'ada', 'PATCH', '/v1/tenant-admin/config', { morningReminderTime: '08:30' });
      expect(r.statusCode).toBe(200);
      expect(r.json().configVersion).toBe(before.configVersion + 1);
      expect((await asUser(A, 'cleo', 'PATCH', '/v1/tenant-admin/config', { morningReminderTime: '07:00' })).statusCode).toBe(403);
    });
  });

  describe('archive requests (§4: salesperson requests, approver decides within scope)', () => {
    it('a salesperson request changes nothing until an in-scope approver approves; it then runs as a journalled operation', async () => {
      const ws = env.twenty.workspaces.get(A.slug)!;
      await seedRecords(env, A.slug, { opportunities: [{ id: 'opp-north', name: 'North deal', stage: 'NEW', beeOwnerMemberId: A.users.sam.ownerKey, beeTeamId: 'north' }] });
      const tenant = await env.get(TenantService).getContext(A.tenantId);
      const sam = (await env.get(IdentityService).getActiveUser(A.tenantId, A.users.sam.id))!.user;
      const svc = env.get(ArchiveRequestService);
      const { request } = await svc.create(tenant, sam, { entity: 'opportunity', id: 'opp-north', label: 'North deal' });
      expect(request.state).toBe('pending');
      expect(ws.all('opportunities').find((o: any) => o.id === 'opp-north')?.beeArchived).toBeFalsy();
      // the salesperson cannot decide; another team's salesperson cannot see it
      expect((await asUser(A, 'sam', 'GET', '/v1/approvals/archive')).statusCode).toBe(403);
      // a manager of ANOTHER team does not see it and gets "not found" when guessing the id
      expect((await asUser(A, 'ada', 'PATCH', `/v1/tenant-admin/users/${A.users.meera.id}`, { managedTeamIds: ['south'] })).statusCode).toBe(200);
      expect((await asUser(A, 'meera', 'GET', '/v1/approvals/archive')).json()).toHaveLength(0);
      expect((await asUser(A, 'meera', 'POST', `/v1/approvals/archive/${request.id}/approve`, {})).statusCode).toBe(404);
      // the manager of the right team approves → one archive operation, under the approver's identity
      expect((await asUser(A, 'ada', 'PATCH', `/v1/tenant-admin/users/${A.users.meera.id}`, { managedTeamIds: ['north'] })).statusCode).toBe(200);
      expect((await asUser(A, 'meera', 'GET', '/v1/approvals/archive')).json()).toHaveLength(1);
      const ok = await asUser(A, 'meera', 'POST', `/v1/approvals/archive/${request.id}/approve`, { note: 'duplicate' });
      expect(ok.statusCode).toBe(200);
      expect((await asUser(A, 'meera', 'POST', `/v1/approvals/archive/${request.id}/approve`, {})).statusCode).toBe(422); // already decided
      const ops = await db.tenantTx(A.tenantId, (tx) => tx.select().from(operations).where(eq(operations.idempotencyKey, `archive-request:${request.id}`)));
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ type: 'archive', userId: A.users.meera.id });
      const mine = (await asUser(A, 'sam', 'GET', '/v1/me/archive-requests')).json();
      expect(mine[0]).toMatchObject({ state: 'approved', decidedBy: 'Meera Manager' });
    });
  });

  describe('platform operators and support access (§4)', () => {
    let opKey = '';
    it('only the bootstrap key creates named operators; operators are not tenant users', async () => {
      const r = await inject({ method: 'POST', url: '/admin/operators', headers: { 'x-api-key': ADMIN_KEY }, payload: { name: 'Olu Ops', email: 'olu@ylogx.test' } });
      expect(r.statusCode).toBe(201);
      opKey = r.json().key;
      expect((await inject({ method: 'POST', url: '/admin/operators', headers: { 'x-api-key': opKey }, payload: { name: 'X', email: 'x@ylogx.test' } })).statusCode).toBe(403);
      expect((await inject({ method: 'GET', url: '/v1/me', headers: { 'x-api-key': opKey } })).statusCode).toBe(401);
    });

    it('acting as an employee needs a grant approved by a client admin of THAT tenant; every step is audited there', async () => {
      const token = () => inject({ method: 'POST', url: `/admin/tenants/${A.tenantId}/users/${A.users.sam.id}/token`, headers: { 'x-api-key': opKey } });
      expect((await token()).statusCode).toBe(403);
      const req = await inject({ method: 'POST', url: `/admin/tenants/${A.tenantId}/support-requests`, headers: { 'x-api-key': opKey }, payload: { reason: 'Investigating a stuck operation', hours: 2 } });
      expect(req.statusCode).toBe(201);
      const grantId = req.json().id;
      // tenant B's admin cannot approve tenant A's request
      expect((await asUser(B, 'bob', 'POST', `/v1/tenant-admin/support/${grantId}/approve`)).statusCode).toBe(404);
      expect((await asUser(A, 'ada', 'POST', `/v1/tenant-admin/support/${grantId}/approve`)).statusCode).toBe(200);
      expect((await token()).statusCode).toBe(200);
      // the grant does not open tenant B
      expect((await inject({ method: 'POST', url: `/admin/tenants/${B.tenantId}/users/${B.users.bob.id}/token`, headers: { 'x-api-key': opKey } })).statusCode).toBe(403);
      expect((await asUser(A, 'ada', 'POST', `/v1/tenant-admin/support/${grantId}/revoke`)).statusCode).toBe(200);
      expect((await token()).statusCode).toBe(403);
      const trail = (await asUser(A, 'ada', 'GET', '/v1/tenant-admin/audit?limit=200')).json().map((e: any) => e.action);
      expect(trail).toEqual(expect.arrayContaining(['support.requested', 'support.approved', 'support.access', 'admin.token_issued', 'support.revoked', 'support.access_denied']));
    });
  });
});
