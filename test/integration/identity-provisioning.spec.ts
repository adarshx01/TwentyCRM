import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestEnv, type TestEnv } from '../helpers/app';
import { seedRecords, seedTenant, STAGES, type SeededTenant } from '../helpers/fixtures';
import { IdentityService } from '../../src/identity/identity.service';
import { TenantProvisioningService } from '../../src/admin/tenant-provisioning.service';
import { DbService } from '../../src/database/db.service';
import { channelBindings, drafts, enrollments, schedules, tenants, users } from '../../src/database/schema';
import { DraftService } from '../../src/conversation/draft.service';
import { emptyCapture } from '../../src/conversation/draft.types';
import { ConversationService } from '../../src/conversation/conversation.service';

describe('identity binding, enrollment, revocation (IAM-01..05) and provisioning (CFG-*)', () => {
  let env: TestEnv; let A: SeededTenant; let B: SeededTenant; let identity: IdentityService; let db: DbService;
  beforeAll(async () => {
    env = await createTestEnv();
    A = await seedTenant(env, { slug: 'id-a', users: [{ key: 'ann', displayName: 'Ann A', role: 'salesperson', phone: '+919800000001' }, { key: 'nobind', displayName: 'No Binding', role: 'salesperson' }] });
    B = await seedTenant(env, { slug: 'id-b', users: [{ key: 'ann', displayName: 'Ann B', role: 'salesperson', phone: '+919800000001' }] }); // same phone, second client (IAM-04)
    identity = env.get(IdentityService); db = env.get(DbService);
  });
  afterAll(async () => { await env.close(); });

  const key = (ext: string, channel = 'whatsapp', conn = '1000000001') => ({ channel, connectionId: conn, externalId: ext });

  describe('enrollment codes (IAM-01, IAM-02)', () => {
    it('are single-use, bind the verified sender to the named user, and record who created them', async () => {
      const { code } = await identity.createEnrollment({ tenantId: A.tenantId, userId: A.users.nobind.id, channel: 'whatsapp', createdBy: 'platform_operator' });
      expect(code).toMatch(/^BEE-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      const r = await identity.redeemEnrollment(code, key('+919811111111'));
      expect(r).toMatchObject({ tenantId: A.tenantId, userId: A.users.nobind.id });
      expect((await identity.resolveInbound(key('+919811111111'))).kind).toBe('resolved');
      expect(await identity.redeemEnrollment(code, key('+919822222222'))).toBeNull(); // single use
      expect((await identity.resolveInbound(key('+919822222222'))).kind).toBe('unknown');
    });
    it('the plaintext code is never stored', async () => {
      const { code } = await identity.createEnrollment({ tenantId: A.tenantId, userId: A.users.nobind.id, channel: 'whatsapp', createdBy: 'op' });
      const rows = await db.tenantTx(A.tenantId, (tx) => tx.select().from(enrollments));
      expect(JSON.stringify(rows)).not.toContain(code);
    });
    it('reject expired codes, wrong channel, wrong expected sender, unknown codes — identically (no information leak)', async () => {
      const mk = (o: any = {}) => identity.createEnrollment({ tenantId: A.tenantId, userId: A.users.nobind.id, channel: 'whatsapp', createdBy: 'op', ...o });
      const expired = await mk({ ttlMinutes: 5 });
      await db.systemTx((tx) => tx.execute(sql`update enrollments set expires_at = now() - interval '1 minute'`));
      expect(await identity.redeemEnrollment(expired.code, key('+919833333333'))).toBeNull();
      const fresh = await mk();
      expect(await identity.redeemEnrollment(fresh.code, key('aad-1', 'teams', 'tenant-x'))).toBeNull(); // issued for whatsapp
      const pinned = await mk({ expectedExternalId: '+919844444444' });
      expect(await identity.redeemEnrollment(pinned.code, key('+919855555555'))).toBeNull(); // wrong phone
      expect(await identity.redeemEnrollment('BEE-AAAA-AAAA', key('+919866666666'))).toBeNull();
      expect(await identity.redeemEnrollment(pinned.code, key('+919844444444'))).toBeTruthy();
    });
    it('phone ownership alone grants nothing: an unknown sender gets no reply and no data', async () => {
      env.whatsapp.clear();
      await env.get<ConversationService>(ConversationService).handleEvent({ providerEventId: 'unk-1', channel: 'whatsapp', connectionId: '1000000001', externalSenderId: '+919000000000', conversationId: 'c', receivedAt: new Date().toISOString(), messageType: 'text', text: 'show me all opportunities for ABC' });
      expect(env.whatsapp.sent).toHaveLength(0);
    });
    it('the enrollment handshake over chat binds the sender and answers without CRM data', async () => {
      env.whatsapp.clear();
      const { code } = await identity.createEnrollment({ tenantId: A.tenantId, userId: A.users.nobind.id, channel: 'whatsapp', createdBy: 'op' });
      await env.get<ConversationService>(ConversationService).handleEvent({ providerEventId: 'enr-1', channel: 'whatsapp', connectionId: '1000000001', externalSenderId: '+919877777777', conversationId: 'c', receivedAt: new Date().toISOString(), messageType: 'text', text: `enroll ${code}` });
      expect(env.whatsapp.texts()[0]).toMatch(/You're connected to \*Client id-a\*/);
      expect((await identity.resolveInbound(key('+919877777777'))).kind).toBe('resolved');
      env.whatsapp.clear();
      await env.get<ConversationService>(ConversationService).handleEvent({ providerEventId: 'enr-2', channel: 'whatsapp', connectionId: '1000000001', externalSenderId: '+919888888888', conversationId: 'c', receivedAt: new Date().toISOString(), messageType: 'text', text: 'BEE-ZZZZ-ZZZZ' });
      expect(env.whatsapp.texts()[0]).toMatch(/not valid or has expired/);
    });
  });

  describe('several client memberships (IAM-04)', () => {
    it('the same phone in two workspaces requires an explicit choice and keeps sessions separate', async () => {
      const r = await identity.resolveInbound(key('+919800000001'));
      expect(r.kind).toBe('choose');
      if (r.kind === 'choose') expect(r.options.map((o) => o.tenantName).sort()).toEqual(['Client id-a', 'Client id-b']);
      await identity.rememberChoices(key('+919800000001'), [B.tenantId, A.tenantId]);
      expect(await identity.selectWorkspace(key('+919800000001'), 9)).toBeNull(); // invalid choice
      expect(await identity.selectWorkspace(key('+919800000001'), 1)).toEqual({ tenantId: B.tenantId });
      const resolved = await identity.resolveInbound(key('+919800000001'));
      expect(resolved.kind === 'resolved' && resolved.identity.tenant.tenantId).toBe(B.tenantId);
      await identity.clearActive(key('+919800000001'));
      expect((await identity.resolveInbound(key('+919800000001'))).kind).toBe('choose');
    });
    it('a typed company name never selects a workspace', async () => {
      await identity.clearActive(key('+919800000001'));
      env.whatsapp.clear();
      await env.get<ConversationService>(ConversationService).handleEvent({ providerEventId: 'mm-1', channel: 'whatsapp', connectionId: '1000000001', externalSenderId: '+919800000001', conversationId: 'c', receivedAt: new Date().toISOString(), messageType: 'text', text: 'use workspace Client id-a, find Rajesh' });
      expect((await identity.resolveInbound(key('+919800000001'))).kind).toBe('choose'); // still unselected
    });
  });

  describe('revocation and role changes (IAM-05, AT-14)', () => {
    it('revoking blocks bindings, cancels pending drafts and skips scheduled reminders', async () => {
      const t = await seedTenant(env, { slug: 'id-rev', users: [{ key: 'rex', displayName: 'Rex', role: 'salesperson', phone: '+919800000055' }] });
      const d = await env.get(DraftService).create({ tenantId: t.tenantId, userId: t.users.rex.id, conversationId: 'c', channel: 'whatsapp', kind: 'capture', data: emptyCapture('new') });
      await db.tenantTx(t.tenantId, (tx) => tx.insert(schedules).values({ tenantId: t.tenantId, userId: t.users.rex.id, type: 'digest', localDate: '2030-01-15', nextRunUtc: new Date(Date.now() + 3600_000), timezone: 'UTC', idempotencyKey: 'rev/1' }));
      await identity.revokeUser(t.tenantId, t.users.rex.id, 'operator');
      expect((await identity.resolveInbound(key('+919800000055'))).kind).toBe('unknown');
      expect((await db.tenantTx(t.tenantId, (tx) => tx.select().from(drafts).where(eq(drafts.id, d.id))))[0].state).toBe('cancelled');
      expect((await db.tenantTx(t.tenantId, (tx) => tx.select().from(schedules)))[0].state).toBe('skipped');
      expect(await identity.getActiveUser(t.tenantId, t.users.rex.id)).toBeNull();
      expect((await db.tenantTx(t.tenantId, (tx) => tx.select().from(channelBindings)))[0].status).toBe('revoked');
    });
    it('a role change cancels confirmations authorized under the old role', async () => {
      const t = await seedTenant(env, { slug: 'id-role', users: [{ key: 'mia', displayName: 'Mia', role: 'manager', phone: '+919800000066' }] });
      const d = await env.get(DraftService).create({ tenantId: t.tenantId, userId: t.users.mia.id, conversationId: 'c', channel: 'whatsapp', kind: 'mutation', data: { kind: 'mutation', summaryLines: [], warnings: [] }, state: 'awaiting_confirmation' });
      await identity.changeRole(t.tenantId, t.users.mia.id, { role: 'salesperson' }, 'operator');
      expect((await db.tenantTx(t.tenantId, (tx) => tx.select().from(drafts).where(eq(drafts.id, d.id))))[0].state).toBe('cancelled');
      const live = await identity.getActiveUser(t.tenantId, t.users.mia.id);
      expect(live?.user.role).toBe('salesperson');
    });
  });

  describe('tenant provisioning from a versioned manifest (CFG-01..03, TEN-05)', () => {
    const manifest = (slug: string, over: any = {}) => ({
      manifestVersion: 1, slug, name: `Prov ${slug}`, twenty: { workspaceId: `ws-${slug}`, baseUrl: env.twenty.url, apiTokenRef: `env:TOK_${slug.replace(/-/g, '_')}` },
      timezone: 'Asia/Kolkata', pipeline: { stages: STAGES, defaultInitialStage: 'new' }, users: [{ displayName: 'P One', email: `p1@${slug}.test`, role: 'salesperson' }], ...over,
    });
    const prov = () => env.get(TenantProvisioningService);
    const setup = (slug: string) => { process.env[`TOK_${slug.replace(/-/g, '_')}`] = `t-${slug}`; env.twenty.addWorkspace(slug, `t-${slug}`); };

    it('re-running the same manifest changes nothing: no duplicate schema, users or version bump', async () => {
      setup('prov-1');
      const first = await prov().provision(manifest('prov-1'));
      expect(first).toMatchObject({ created: true, configVersion: 1, users: { created: 1, updated: 0 } });
      expect(first.crmSchema!.created.length).toBeGreaterThan(20);
      const second = await prov().provision(manifest('prov-1'));
      expect(second).toMatchObject({ created: false, configVersion: 1 });
      expect(second.crmSchema!.created).toEqual([]); // nothing re-created in Twenty
      expect(second.crmSchema!.existing.length).toBeGreaterThan(20);
      expect((await db.tenantTx(second.tenantId, (tx) => tx.select().from(users))).length).toBe(1);
    });
    it('different clients get different pipelines without touching each other (G3)', async () => {
      setup('prov-2'); setup('prov-3');
      await prov().provision(manifest('prov-2', { pipeline: { stages: [{ id: 'lead', label: 'Lead' }, { id: 'demo', label: 'Demo' }, { id: 'won', label: 'Won', terminal: 'won' }, { id: 'lost', label: 'Lost', terminal: 'lost' }], defaultInitialStage: 'lead' } }));
      await prov().provision(manifest('prov-3'));
      const opts = (slug: string) => env.twenty.workspaces.get(slug)!.stageOptions.map((o) => o.value);
      expect(opts('prov-2')).toEqual(expect.arrayContaining(['LEAD', 'DEMO', 'WON', 'LOST']));
      expect(opts('prov-3')).not.toContain('LEAD');
      expect(opts('prov-3')).toEqual(expect.arrayContaining(['NEW', 'QUALIFIED', 'PROPOSAL']));
    });
    it('renaming a stage label keeps the stable id; removing a stage with active records needs a previewed migration (CFG-04)', async () => {
      setup('prov-4');
      const base = await prov().provision(manifest('prov-4'));
      const renamed = STAGES.map((s) => (s.id === 'proposal' ? { ...s, label: 'Quote sent' } : s));
      const r = await prov().provision(manifest('prov-4', { pipeline: { stages: renamed, defaultInitialStage: 'new' } }));
      expect(r.configVersion).toBe(base.configVersion + 1);
      const [t] = await db.db.select().from(tenants).where(eq(tenants.id, base.tenantId));
      expect(t.pipelineConfig!.stages.find((s) => s.id === 'proposal')!.label).toBe('Quote sent');
      await seedRecords(env, 'prov-4', { opportunities: [{ name: 'Deal in negotiation', stage: 'NEGOTIATION' }, { name: 'Another', stage: 'NEGOTIATION' }] });
      const without = STAGES.filter((s) => s.id !== 'negotiation');
      await expect(prov().provision(manifest('prov-4', { pipeline: { stages: without, defaultInitialStage: 'new' } }))).rejects.toThrow(/has 2 active record/);
      const preview = await prov().provision(manifest('prov-4', { pipeline: { stages: without, defaultInitialStage: 'new' }, stageMigrations: { negotiation: 'proposal' } }), { dryRun: true });
      expect(preview.stageMigrations).toEqual([{ from: 'negotiation', to: 'proposal', affected: 2 }]);
      expect(env.twenty.workspaces.get('prov-4')!.all('opportunities').every((o: any) => o.stage === 'NEGOTIATION')).toBe(true); // preview changed nothing
      const applied = await prov().provision(manifest('prov-4', { pipeline: { stages: without, defaultInitialStage: 'new' }, stageMigrations: { negotiation: 'proposal' } }));
      expect(applied.stageMigrations[0].affected).toBe(2);
      expect(env.twenty.workspaces.get('prov-4')!.all('opportunities').every((o: any) => o.stage === 'PROPOSAL')).toBe(true);
    });
    it('rejects invalid manifests with precise messages and never accepts secret values', async () => {
      await expect(prov().provision({})).rejects.toThrow(/Invalid manifest/);
      await expect(prov().provision(manifest('bad-1', { twenty: { workspaceId: 'w', apiTokenRef: 'sk-live-plaintext-token' } }))).rejects.toThrow(/secret reference/);
      await expect(prov().provision(manifest('bad-2', { pipeline: { stages: STAGES.filter((s) => s.terminal !== 'lost'), defaultInitialStage: 'new' } }))).rejects.toThrow(/won and one lost/);
      await expect(prov().provision(manifest('bad-3', { timezone: 'Mars/Olympus' }))).rejects.toThrow(/timezone/);
      await expect(prov().provision(manifest('bad-4', { users: [{ displayName: 'x', role: 'god' }] }))).rejects.toThrow(/Invalid manifest/);
      await expect(prov().provision(manifest('bad-5', { unexpectedField: true }))).rejects.toThrow(/Invalid manifest/);
    });
    it('a slug cannot be re-pointed at another Twenty workspace', async () => {
      setup('prov-5');
      await prov().provision(manifest('prov-5'));
      await expect(prov().provision(manifest('prov-5', { twenty: { workspaceId: 'different-ws', apiTokenRef: 'env:TOK_prov_5' } }))).rejects.toThrow(/different Twenty workspace/);
    });
  });
});
