import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { ADMIN_KEY, WA_PHONE_ID, WA_VERIFY, createTestEnv, type TestEnv } from '../helpers/app';
import { jwtFor, seedTenant, waSign, type SeededTenant } from '../helpers/fixtures';
import { DbService } from '../../src/database/db.service';
import { channelBindings, deliveryState, inboundEvents } from '../../src/database/schema';
import { generateToken } from '../../src/common/guards/auth.guard';
import { QUEUES } from '../../src/queue/queues';
import { QueueService } from '../../src/queue/queue.service';

describe('webhooks, authentication and HTTP surface (§9, SEC-01)', () => {
  let env: TestEnv; let T: SeededTenant; let db: DbService;
  beforeAll(async () => {
    env = await createTestEnv();
    T = await seedTenant(env, { slug: 'hook-co', users: [
      { key: 'sam', displayName: 'Sam', role: 'salesperson', phone: '+919800000001', aadId: 'aad-sam' },
      { key: 'cxo', displayName: 'Cxo', role: 'cxo', phone: '+919800000002' },
    ] });
    db = env.get(DbService);
  });
  afterAll(async () => { await env.close(); });

  const inject = (o: any) => env.app.inject(o);
  const waPayload = (id: string, text = 'hello') => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: WA_PHONE_ID }, messages: [{ id, from: '919800000001', timestamp: '1790000000', type: 'text', text: { body: text } }] } }] }] });
  const post = (payload: any, sig?: string | null) => { const raw = JSON.stringify(payload); return inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', ...(sig === null ? {} : { 'x-hub-signature-256': sig ?? waSign(raw) }) }, payload: raw }); };
  const queued = async (name: string) => { await env.get<QueueService>(QueueService).relay(); const c = await env.get<QueueService>(QueueService).counts(name as any); return c.waiting + c.delayed + c.active + c.completed + c.failed; };

  describe('WhatsApp', () => {
    it('verification handshake: right token echoes the challenge, wrong token is refused', async () => {
      const ok = await inject({ method: 'GET', url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${WA_VERIFY}&hub.challenge=12345` });
      expect(ok.statusCode).toBe(200); expect(ok.body).toBe('12345');
      expect((await inject({ method: 'GET', url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' })).statusCode).toBe(403);
      expect((await inject({ method: 'GET', url: '/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=1' })).statusCode).toBe(403);
    });
    it('rejects missing, malformed, wrong and tampered signatures without persisting anything', async () => {
      const before = (await db.systemTx((tx) => tx.select().from(inboundEvents))).length;
      expect((await post(waPayload('wamid.bad1'), null)).statusCode).toBe(401);
      expect((await post(waPayload('wamid.bad2'), 'sha256=00')).statusCode).toBe(401);
      expect((await post(waPayload('wamid.bad3'), `sha256=${createHmac('sha256', 'wrong').update(JSON.stringify(waPayload('wamid.bad3'))).digest('hex')}`)).statusCode).toBe(401);
      const raw = JSON.stringify(waPayload('wamid.bad4', 'original'));
      expect((await inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': waSign(raw) }, payload: raw.replace('original', 'tampered') })).statusCode).toBe(401);
      expect((await db.systemTx((tx) => tx.select().from(inboundEvents))).length).toBe(before);
    });
    it('a valid event is durably accepted and enqueued within the target; replays are suppressed (ACT-05)', async () => {
      const t0 = Date.now();
      const r = await post(waPayload('wamid.ok1'));
      expect(r.statusCode).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2000); // durable acceptance p95 < 2 s
      expect(r.json()).toMatchObject({ accepted: 1, duplicates: 0 });
      const before = await queued(QUEUES.INBOUND);
      expect((await post(waPayload('wamid.ok1'))).json()).toMatchObject({ accepted: 0, duplicates: 1 });
      expect(await queued(QUEUES.INBOUND)).toBe(before);
      expect((await db.systemTx((tx) => tx.select().from(inboundEvents).where(eq(inboundEvents.providerEventId, 'wamid.ok1'))))).toHaveLength(1);
    });
    it('a burst of the same event delivered concurrently still produces one event', async () => {
      const rs = await Promise.all(Array.from({ length: 15 }, () => post(waPayload('wamid.race'))));
      expect(rs.every((r) => r.statusCode === 200)).toBe(true);
      expect((await db.systemTx((tx) => tx.select().from(inboundEvents).where(eq(inboundEvents.providerEventId, 'wamid.race'))))).toHaveLength(1);
    });
    it('delivery receipts update delivery state separately and need no business processing', async () => {
      await db.tenantTx(T.tenantId, (tx) => tx.insert(deliveryState).values({ tenantId: T.tenantId, userId: T.users.sam.id, channel: 'whatsapp', messageType: 'chat_reply', idempotencyKey: 'rcpt-1', externalMessageId: 'wamid.OUT1', status: 'sent' }));
      const body = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: WA_PHONE_ID }, statuses: [{ id: 'wamid.OUT1', status: 'delivered' }] } }] }] };
      expect((await post(body)).statusCode).toBe(200);
      expect((await db.tenantTx(T.tenantId, (tx) => tx.select().from(deliveryState).where(eq(deliveryState.idempotencyKey, 'rcpt-1'))))[0].status).toBe('delivered');
    });
    it('malformed JSON is a 400, not a crash', async () => {
      const raw = '{"entry": [';
      const r = await inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': waSign(raw) }, payload: raw });
      expect(r.statusCode).toBe(400);
    });
    it('an "opted out" failure receipt stops future sends to that employee (AT-10)', async () => {
      const body = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: WA_PHONE_ID }, statuses: [{ id: 'wamid.OUT1', status: 'failed', recipient_id: '919800000002', errors: [{ code: 131050, title: 'User opted out' }] }] } }] }] };
      await post(body);
      expect((await db.systemTx((tx) => tx.select().from(channelBindings).where(eq(channelBindings.externalId, '+919800000002'))))[0].optedOut).toBe(true);
    });
  });

  describe('Teams', () => {
    const activity = (id: string, over: any = {}) => ({ type: 'message', id, timestamp: '2026-09-28T04:00:00Z', serviceUrl: 'https://smba.trafficmanager.net/emea/', from: { id: '29:x', aadObjectId: 'aad-sam' }, recipient: { id: '28:bot' }, conversation: { id: 'conv-sam', conversationType: 'personal', tenantId: 'entra-tenant-1' }, channelData: { tenant: { id: 'entra-tenant-1' } }, text: 'hello', ...over });
    const tpost = (a: any, token?: string) => inject({ method: 'POST', url: '/webhooks/teams', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: JSON.stringify(a) });
    it('rejects activities without a valid Microsoft token', async () => {
      expect((await tpost(activity('t1'))).statusCode).toBe(401);
      expect((await tpost(activity('t1'), 'forged')).statusCode).toBe(401);
      expect((await db.systemTx((tx) => tx.select().from(inboundEvents).where(eq(inboundEvents.providerEventId, 't1')))).length).toBe(0);
    });
    it('accepts a valid personal-chat message, de-duplicates, and ignores unmentioned channel chatter (TM-04)', async () => {
      expect((await tpost(activity('t2'), 'valid-teams-token')).statusCode).toBe(200);
      await tpost(activity('t2'), 'valid-teams-token');
      expect((await db.systemTx((tx) => tx.select().from(inboundEvents).where(eq(inboundEvents.providerEventId, 't2'))))).toHaveLength(1);
      const chan = await tpost(activity('t3', { conversation: { id: 'chan', conversationType: 'channel', tenantId: 'entra-tenant-1' }, text: 'unrelated discussion' }), 'valid-teams-token');
      expect(chan.json()).toMatchObject({ ignored: true });
      expect((await db.systemTx((tx) => tx.select().from(inboundEvents).where(eq(inboundEvents.providerEventId, 't3'))))).toHaveLength(0);
    });
    it('uninstall clears the conversation reference so proactive sends fail cleanly; reinstall restores it (TM-02, AT-11)', async () => {
      await tpost(activity('t4', { type: 'installationUpdate', action: 'remove' }), 'valid-teams-token');
      const get = async () => (await db.systemTx((tx) => tx.select().from(channelBindings).where(eq(channelBindings.externalId, 'aad-sam'))))[0];
      expect((await get()).conversationRef).toBeNull();
      await tpost(activity('t5', { type: 'installationUpdate', action: 'add' }), 'valid-teams-token');
      expect((await get()).conversationRef).toMatchObject({ conversationId: 'conv-sam' });
    });
    it('an activity from another Entra tenant never resolves to this client\'s user (IAM-03)', async () => {
      const { IdentityService } = await import('../../src/identity/identity.service');
      const res = await env.get<InstanceType<typeof IdentityService>>(IdentityService).resolveInbound({ channel: 'teams', connectionId: 'someone-elses-tenant', externalId: 'aad-sam' });
      expect(res.kind).toBe('unknown');
    });
  });

  describe('employee and admin APIs', () => {
    it('employee routes need a token; admin routes need the operator key; health is public', async () => {
      expect((await inject({ method: 'GET', url: '/operations/00000000-0000-0000-0000-000000000000' })).statusCode).toBe(401);
      expect((await inject({ method: 'GET', url: '/operations/00000000-0000-0000-0000-000000000000', headers: { authorization: 'Bearer junk' } })).statusCode).toBe(401);
      expect((await inject({ method: 'GET', url: '/admin/tenants' })).statusCode).toBe(401);
      expect((await inject({ method: 'GET', url: '/admin/tenants', headers: { 'x-api-key': 'wrong' } })).statusCode).toBe(401);
      expect((await inject({ method: 'GET', url: '/admin/tenants', headers: { 'x-api-key': ADMIN_KEY } })).statusCode).toBe(200);
      expect((await inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      // a user token is not an admin credential
      expect((await inject({ method: 'GET', url: '/admin/tenants', headers: { authorization: `Bearer ${jwtFor(T, 'cxo')}` } })).statusCode).toBe(401);
    });
    it('the tenant comes from the token + live user, never from the request (cross-tenant ids → 404)', async () => {
      const other = await seedTenant(env, { slug: 'hook-other', users: [{ key: 'olly', displayName: 'Olly', role: 'salesperson', phone: '+919800000077' }] });
      const { DraftService } = await import('../../src/conversation/draft.service');
      const { emptyCapture } = await import('../../src/conversation/draft.types');
      const d = await env.get<InstanceType<typeof DraftService>>(DraftService).create({ tenantId: other.tenantId, userId: other.users.olly.id, conversationId: 'c', channel: 'whatsapp', kind: 'capture', data: emptyCapture('new') });
      const r = await inject({ method: 'GET', url: `/drafts/${d.id}`, headers: { authorization: `Bearer ${jwtFor(T, 'sam')}` } });
      expect(r.statusCode).toBe(404);
      const own = await inject({ method: 'GET', url: `/drafts/${d.id}`, headers: { authorization: `Bearer ${jwtFor(other, 'olly')}` } });
      expect(own.statusCode).toBe(200);
      // a token claiming tenant B but a user of tenant A is refused (live membership check)
      const forged = generateToken({ userId: T.users.sam.id, tenantId: other.tenantId }, 'test-jwt-secret-test-jwt-secret-12345');
      expect((await inject({ method: 'GET', url: `/drafts/${d.id}`, headers: { authorization: `Bearer ${forged}` } })).statusCode).toBe(401);
    });
    it('revocation takes effect immediately for API tokens (IAM-05)', async () => {
      const token = jwtFor(T, 'cxo');
      expect((await inject({ method: 'GET', url: '/intake/review', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
      await env.get<DbService>(DbService).systemTx((tx) => tx.execute(sql`update users set status = 'revoked', revoked_at = now() where id = ${T.users.cxo.id}`));
      expect((await inject({ method: 'GET', url: '/intake/review', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
      await env.get<DbService>(DbService).systemTx((tx) => tx.execute(sql`update users set status = 'active', revoked_at = null where id = ${T.users.cxo.id}`));
    });
    it('role guard: a salesperson cannot use the intake review API', async () => {
      expect((await inject({ method: 'GET', url: '/intake/review', headers: { authorization: `Bearer ${jwtFor(T, 'sam')}` } })).statusCode).toBe(403);
    });
    it('confirm requires an Idempotency-Key and strictly validated body', async () => {
      const id = '00000000-0000-0000-0000-000000000001';
      const h = { authorization: `Bearer ${jwtFor(T, 'sam')}`, 'content-type': 'application/json' };
      expect((await inject({ method: 'POST', url: `/drafts/${id}/confirm`, headers: h, payload: { version: 1, hash: 'deadbeef' } })).statusCode).toBe(400);
      expect((await inject({ method: 'POST', url: `/drafts/${id}/confirm`, headers: { ...h, 'idempotency-key': 'key-12345678' }, payload: { version: 1, hash: 'zz' } })).statusCode).toBe(400);
      expect((await inject({ method: 'POST', url: `/drafts/${id}/confirm`, headers: { ...h, 'idempotency-key': 'key-12345678' }, payload: { version: 1, hash: 'deadbeef', tenantId: 'x' } })).statusCode).toBe(400);
      expect((await inject({ method: 'POST', url: `/drafts/${id}/confirm`, headers: { ...h, 'idempotency-key': 'key-12345678' }, payload: { version: 1, hash: 'deadbeef' } })).statusCode).toBe(404);
      expect((await inject({ method: 'GET', url: '/drafts/not-a-uuid', headers: h })).statusCode).toBe(400);
    });
    it('errors never leak internals and carry a correlation id', async () => {
      const r = await inject({ method: 'GET', url: '/operations/00000000-0000-0000-0000-000000000009', headers: { authorization: `Bearer ${jwtFor(T, 'sam')}`, 'x-correlation-id': 'corr-test-12345' } });
      expect(r.statusCode).toBe(404);
      expect(r.headers['x-correlation-id']).toBe('corr-test-12345');
      expect(r.body).not.toMatch(/stack|postgres|select |node_modules/i);
    });
    it('readiness reflects dependencies; metrics need a token', async () => {
      const ready = await inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(200); expect(ready.json().checks).toMatchObject({ database: true, queue: true });
      expect((await inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
      const m = await inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-token' } });
      expect(m.statusCode).toBe(200); expect(m.body).toContain('webhook_received_total'); expect(m.body).toContain('webhook_auth_failures_total');
      const det = await inject({ method: 'GET', url: '/health/detailed', headers: { 'x-api-key': ADMIN_KEY } });
      expect(det.statusCode).toBe(200); expect(det.json()).toHaveProperty('queues'); expect(det.json()).toHaveProperty('deadLettersOpen');
    });
  });

  describe('Twenty change events (SYNC-02)', () => {
    const sign = (secret: string, ts: string, raw: string) => createHmac('sha256', secret).update(`${ts}:${raw}`).digest('hex');
    it('a correctly signed event queues a reconciliation; bad/stale/unknown are refused identically; the payload is never trusted', async () => {
      process.env.TWENTY_HOOK_SECRET = 'twenty-hook-secret';
      await db.db.execute(sql`update tenants set settings = settings || '{"twentyWebhookSecretRef":"env:TWENTY_HOOK_SECRET"}'::jsonb where id = ${T.tenantId}`);
      const raw = JSON.stringify({ eventName: 'opportunity.updated', objectMetadata: { nameSingular: 'opportunity' }, record: { id: 'attacker-chosen', stage: 'WON' } });
      const ts = String(Date.now());
      const call = (slug: string, headers: any) => inject({ method: 'POST', url: `/webhooks/twenty/${slug}`, headers: { 'content-type': 'application/json', ...headers }, payload: raw });
      const before = await queued(QUEUES.RECONCILIATION);
      expect((await call('hook-co', { 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': sign('twenty-hook-secret', ts, raw) })).statusCode).toBe(202);
      expect(await queued(QUEUES.RECONCILIATION)).toBe(before + 1);
      expect((await call('hook-co', { 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': sign('twenty-hook-secret', ts, raw) })).statusCode).toBe(202); // debounced: same 20s window
      expect(await queued(QUEUES.RECONCILIATION)).toBe(before + 1);
      expect((await call('hook-co', { 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': sign('wrong', ts, raw) })).statusCode).toBe(401);
      const stale = String(Date.now() - 20 * 60_000);
      expect((await call('hook-co', { 'x-twenty-webhook-timestamp': stale, 'x-twenty-webhook-signature': sign('twenty-hook-secret', stale, raw) })).statusCode).toBe(401);
      expect((await call('no-such-tenant', { 'x-twenty-webhook-timestamp': ts, 'x-twenty-webhook-signature': sign('twenty-hook-secret', ts, raw) })).statusCode).toBe(401);
      expect((await call('hook-co', {})).statusCode).toBe(401);
    });
  });

  describe('inbound email webhook', () => {
    const body = (o: any = {}) => ({ eventId: 'e1', recipient: 'nobody@intake.example', rawEmailBase64: Buffer.from('From: a@b.c\r\n\r\nhi').toString('base64'), ...o });
    const epost = (payload: any, secret = 'email-secret', provider = 'testmail') => { const raw = JSON.stringify(payload); return inject({ method: 'POST', url: `/intake/email/${provider}`, headers: { 'content-type': 'application/json', 'x-signature': createHmac('sha256', secret).update(raw).digest('hex') }, payload: raw }); };
    it('requires a valid provider signature', async () => {
      expect((await epost(body(), 'wrong')).statusCode).toBe(401);
      expect((await epost(body(), 'email-secret', 'unknown-provider')).statusCode).toBe(401);
      expect((await inject({ method: 'POST', url: '/intake/email/testmail', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body()) })).statusCode).toBe(401);
    });
    it('an authenticated event for an unknown route is quarantined, not processed', async () => {
      const r = await epost(body());
      expect(r.statusCode).toBe(202); expect(r.json().status).toBe('quarantined');
    });
    it('strict envelope: extra fields are rejected', async () => {
      expect((await epost(body({ tenantId: 'x' }))).statusCode).toBe(400);
    });
  });
});
