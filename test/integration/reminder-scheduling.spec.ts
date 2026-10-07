import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { createTestEnv, type TestEnv } from '../helpers/app';
import { seedRecords, seedTenant, type SeededTenant } from '../helpers/fixtures';
import { DbService } from '../../src/database/db.service';
import { deliveryState, schedules } from '../../src/database/schema';
import { SchedulePlanner } from '../../src/reminders/schedule-planner.service';
import { SchedulerService } from '../../src/reminders/scheduler.service';
import { DigestService } from '../../src/reminders/digest.service';
import { OutboundService } from '../../src/outbound/outbound.service';
import { ReconciliationService } from '../../src/crm/reconciliation.service';
import { QueueService } from '../../src/queue/queue.service';

describe('morning digests: scheduling, dispatch, delivery (REM-*, AT-08, AT-09, AT-10)', () => {
  let env: TestEnv; let T: SeededTenant; let db: DbService; let planner: SchedulePlanner; let scheduler: SchedulerService; let digest: DigestService; let outbound: OutboundService; let ws: any;
  const NOW = new Date('2026-09-28T02:00:00Z'); // Mon 07:30 IST, 22:00 Sun in New York
  const own = (k: string) => ({ beeOwnerMemberId: T.users[k].memberId, beeTeamId: 'team-a' });

  beforeAll(async () => {
    env = await createTestEnv();
    T = await seedTenant(env, { slug: 'digest-co', users: [
      { key: 'sam', displayName: 'Sam Seller', role: 'salesperson', phone: '+919800000001', teamId: 'team-a' },
      { key: 'nina', displayName: 'Nina NY', role: 'salesperson', phone: '+919800000002', teamId: 'team-a', timezone: 'America/New_York' },
      { key: 'maya', displayName: 'Maya Manager', role: 'manager', phone: '+919800000003', teamId: 'team-a' },
    ] });
    db = env.get(DbService); planner = env.get(SchedulePlanner); scheduler = env.get(SchedulerService); digest = env.get(DigestService); outbound = env.get(OutboundService);
    ws = env.twenty.workspaces.get('digest-co');
    await env.get(QueueService).start().catch(() => undefined);
  });
  afterAll(async () => { await env.close(); });

  beforeEach(async () => {
    await db.systemTx(async (tx) => { await tx.execute(sql`delete from schedules`); await tx.execute(sql`delete from delivery_state`); });
    for (const k of ['tasks', 'people', 'companies', 'opportunities']) ws.data[k] = [];
    env.whatsapp.clear(); env.whatsapp.results = [];
    await db.systemTx((tx) => tx.execute(sql`update channel_bindings set last_inbound_at = now(), opted_out = false, status = 'active'`));
    await db.systemTx((tx) => tx.execute(sql`update users set status = 'active', revoked_at = null`));
  });

  const rows = () => db.tenantTx(T.tenantId, (tx) => tx.select().from(schedules));
  const deliveries = () => db.tenantTx(T.tenantId, (tx) => tx.select().from(deliveryState));
  const makeDue = (id?: string) => db.systemTx((tx) => tx.execute(sql`update schedules set next_run_utc = now() - interval '1 minute' ${id ? sql`where id = ${id}` : sql``}`));
  async function deliverAll() { for (const d of await deliveries()) if (d.status === 'pending') await outbound.deliver(T.tenantId, d.id); }
  const task = (o: any) => ({ title: 'Follow up', beeStatus: 'open', status: 'TODO', beeTaskKind: 'follow_up', beeHasTime: false, ...o });

  it('plans one digest per salesperson per working day (REM-01)', async () => {
    const n = await planner.planAll(NOW, 2);
    expect(n).toBe(3); // Sam: Mon+Tue (IST). Nina (New York, still Sunday 22:00): Sunday is non-working, Monday is. Maya is a manager.
  });

  it('plans exact UTC run times per timezone and skips non-working days', async () => {
    await planner.planAll(NOW, 3);
    const r = await rows();
    const byUser = (k: string) => r.filter((x) => x.userId === T.users[k].id).map((x) => [x.localDate, x.nextRunUtc.toISOString()]).sort();
    expect(byUser('sam')).toEqual([['2026-09-28', '2026-09-28T03:30:00.000Z'], ['2026-09-29', '2026-09-29T03:30:00.000Z'], ['2026-09-30', '2026-09-30T03:30:00.000Z']]);
    expect(byUser('nina')).toEqual([['2026-09-28', '2026-09-28T13:00:00.000Z'], ['2026-09-29', '2026-09-29T13:00:00.000Z']]); // Sun 27th skipped; EDT = UTC-4
    expect(r.every((x) => x.userId !== T.users.maya.id)).toBe(true); // digests are for salespeople
  });

  it('weekends are skipped (non-working days)', async () => {
    await planner.planAll(new Date('2026-10-02T00:00:00Z'), 3); // Fri, Sat, Sun in IST (05:30 Fri)
    expect((await rows()).filter((x) => x.userId === T.users.sam.id).map((x) => x.localDate)).toEqual(['2026-10-02']);
  });

  it('keeps 09:00 local across the US spring-forward (AT-08)', async () => {
    const before = await planner.ensureDigest(T.tenantId, T.users.nina.id, '2026-03-06', new Date('2026-03-06T00:00:00Z'));
    const after = await planner.ensureDigest(T.tenantId, T.users.nina.id, '2026-03-09', new Date('2026-03-09T00:00:00Z'));
    expect(before && after).toBe(true);
    const r = Object.fromEntries((await rows()).map((x) => [x.localDate, x.nextRunUtc.toISOString()]));
    expect(r['2026-03-06']).toBe('2026-03-06T14:00:00.000Z'); // EST
    expect(r['2026-03-09']).toBe('2026-03-09T13:00:00.000Z'); // EDT
  });

  it('planning twice creates no duplicate digest (unique tenant/user/date/type key, REM-06)', async () => {
    await planner.planAll(NOW, 2); const first = (await rows()).length;
    await planner.planAll(NOW, 2);
    expect((await rows()).length).toBe(first);
    expect(await planner.ensureDigest(T.tenantId, T.users.sam.id, '2026-09-28', NOW)).toBe(false);
  });

  it('a digest whose cutoff has already passed is not created (REM-07)', async () => {
    expect(await planner.ensureDigest(T.tenantId, T.users.sam.id, '2026-09-28', new Date('2026-09-28T07:00:00Z'))).toBe(false); // 12:30 IST, cutoff 11:00
    expect(await planner.ensureDigest(T.tenantId, T.users.sam.id, '2026-09-28', new Date('2026-09-28T04:00:00Z'))).toBe(true); // 09:30 IST, within cutoff
  });

  it('builds the digest from live CRM data: meetings by time, due today, overdue; excludes done/archived (REM-02, REM-06)', async () => {
    const today = DateTime.now().setZone('Asia/Kolkata').toISODate()!;
    const earlier = DateTime.now().setZone('Asia/Kolkata').minus({ days: 3 }).toISODate()!;
    const p = crypto.randomUUID(); const c = crypto.randomUUID();
    await seedRecords(env, 'digest-co', {
      companies: [{ id: c, name: 'ABC Industries', ...own('sam') }],
      people: [{ id: p, name: { firstName: 'Rajesh', lastName: 'Kumar' }, companyId: c, ...own('sam') }],
      tasks: [
        task({ title: 'Late demo', beeTaskKind: 'meeting', beeHasTime: true, beeDueDate: today, dueAt: DateTime.fromISO(`${today}T15:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO(), beePersonId: p, ...own('sam') }),
        task({ title: 'Early intro', beeTaskKind: 'meeting', beeHasTime: true, beeDueDate: today, dueAt: DateTime.fromISO(`${today}T10:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO(), beePersonId: p, ...own('sam') }),
        task({ title: 'Send proposal', beeDueDate: today, dueAt: DateTime.fromISO(`${today}T00:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO(), ...own('sam') }),
        task({ title: 'Chase invoice', beeDueDate: earlier, dueAt: DateTime.fromISO(`${earlier}T00:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO(), ...own('sam') }),
        task({ title: 'Already done', beeStatus: 'done', status: 'DONE', beeDueDate: today, dueAt: DateTime.fromISO(`${today}T00:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO(), ...own('sam') }),
        task({ title: 'Archived task', beeArchived: true, beeDueDate: today, dueAt: DateTime.fromISO(`${today}T00:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO(), ...own('sam') }),
        task({ title: 'Someone else task', beeDueDate: today, dueAt: DateTime.fromISO(`${today}T00:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO(), ...own('maya') }),
      ],
    });
    await planner.ensureDigest(T.tenantId, T.users.sam.id, today, DateTime.fromISO(`${today}T08:00`, { zone: 'Asia/Kolkata' }).toJSDate());
    const [s] = (await rows()).filter((r) => r.userId === T.users.sam.id);
    await makeDue(s.id);
    expect(await scheduler.tick('w1')).toBe(1);
    const out = await digest.dispatch(T.tenantId, s.id);
    expect(out).toBe('dispatched');
    await deliverAll();
    const text = env.whatsapp.texts(T.users.sam.id)[0];
    expect(text.indexOf('Early intro')).toBeLessThan(text.indexOf('Late demo'));
    expect(text).toMatch(/10:00 AM — Rajesh Kumar \(ABC Industries\)/);
    expect(text).toContain('Send proposal'); expect(text).toContain('Overdue'); expect(text).toContain('Chase invoice');
    expect(text).not.toContain('Already done'); expect(text).not.toContain('Archived task'); expect(text).not.toContain('Someone else');
    expect(text.slice(text.indexOf('Send proposal'), text.indexOf('Overdue'))).not.toMatch(/\d:\d\d (AM|PM)/); // date-only: no invented time
    expect(text).toMatch(/\/object\/task\//);
  });

  it('the job runs twice or restarts halfway: each digest is dispatched once (AT-09)', async () => {
    const today = DateTime.now().setZone('Asia/Kolkata').toISODate()!;
    await seedRecords(env, 'digest-co', { tasks: [task({ title: 'Call back', beeDueDate: today, dueAt: DateTime.fromISO(`${today}T00:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO(), ...own('sam') })] });
    await planner.ensureDigest(T.tenantId, T.users.sam.id, today, DateTime.fromISO(`${today}T08:00`, { zone: 'Asia/Kolkata' }).toJSDate());
    await makeDue();
    // two scheduler instances tick concurrently: SKIP LOCKED means a row is claimed once
    const claimed = await Promise.all([scheduler.tick('w1'), scheduler.tick('w2')]);
    expect(claimed.reduce((a, b) => a + b, 0)).toBe(1);
    const [s] = await rows();
    // the reminder job is executed twice (duplicate delivery of the queue message)
    const [a, b] = await Promise.all([digest.dispatch(T.tenantId, s.id), digest.dispatch(T.tenantId, s.id)]);
    expect([a, b].filter((x) => x === 'dispatched').length).toBeGreaterThanOrEqual(1);
    await digest.dispatch(T.tenantId, s.id); // restart replays it again
    expect((await deliveries()).filter((d) => d.userId === T.users.sam.id)).toHaveLength(1);
    await deliverAll(); await deliverAll();
    expect(env.whatsapp.sent).toHaveLength(1);
  });

  it('a worker that died after claiming leaves the row claimed; it is reclaimed and still sends once', async () => {
    const today = DateTime.now().setZone('Asia/Kolkata').toISODate()!;
    await seedRecords(env, 'digest-co', { tasks: [task({ title: 'Call back', beeDueDate: today, dueAt: DateTime.fromISO(`${today}T00:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO(), ...own('sam') })] });
    await planner.ensureDigest(T.tenantId, T.users.sam.id, today, DateTime.fromISO(`${today}T08:00`, { zone: 'Asia/Kolkata' }).toJSDate());
    await makeDue(); await scheduler.tick('dead-worker');
    expect((await rows())[0].state).toBe('claimed');
    await db.systemTx((tx) => tx.execute(sql`update schedules set claimed_at = now() - interval '20 minutes'`));
    expect(await scheduler.tick('w2')).toBe(1); // reclaimed and claimed again
    const [s] = await rows();
    await digest.dispatch(T.tenantId, s.id);
    expect((await deliveries())).toHaveLength(1);
  });

  it('skips an empty digest, an ineligible (revoked) recipient, and anything past the morning cutoff', async () => {
    const today = DateTime.now().setZone('Asia/Kolkata').toISODate()!;
    const at = DateTime.fromISO(`${today}T08:00`, { zone: 'Asia/Kolkata' }).toJSDate();
    await planner.ensureDigest(T.tenantId, T.users.sam.id, today, at);
    let [s] = await rows();
    expect(await digest.dispatch(T.tenantId, s.id)).toBe('skipped_empty');
    expect((await rows())[0]).toMatchObject({ state: 'skipped' });

    await db.systemTx((tx) => tx.execute(sql`delete from schedules`));
    await planner.ensureDigest(T.tenantId, T.users.sam.id, today, at); [s] = await rows();
    await db.systemTx((tx) => tx.execute(sql`update users set status = 'revoked', revoked_at = now() where id = ${T.users.sam.id}`));
    expect(await digest.dispatch(T.tenantId, s.id)).toBe('skipped_ineligible');

    await db.systemTx((tx) => tx.execute(sql`update users set status = 'active', revoked_at = null; delete from schedules`));
    await planner.ensureDigest(T.tenantId, T.users.sam.id, today, at); [s] = await rows();
    await db.systemTx((tx) => tx.execute(sql`update schedules set next_run_utc = now() - interval '3 hours'`));
    expect(await digest.dispatch(T.tenantId, s.id)).toBe('skipped_cutoff'); // never send an obsolete digest
    expect(await deliveries()).toHaveLength(0);
  });

  describe('WhatsApp reply window and templates (WA-02, WA-03, AT-10)', () => {
    async function dueDigest() {
      const today = DateTime.now().setZone('Asia/Kolkata').toISODate()!;
      await seedRecords(env, 'digest-co', { tasks: [task({ title: 'Call back', beeDueDate: today, dueAt: DateTime.fromISO(`${today}T00:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO(), ...own('sam') })] });
      await planner.ensureDigest(T.tenantId, T.users.sam.id, today, DateTime.fromISO(`${today}T08:00`, { zone: 'Asia/Kolkata' }).toJSDate());
      const [s] = await rows();
      return s;
    }
    it('outside the 24h window only the approved template is sent; the detail follows after the employee replies', async () => {
      await db.systemTx((tx) => tx.execute(sql`update channel_bindings set last_inbound_at = now() - interval '30 hours'`));
      const s = await dueDigest();
      expect(await digest.dispatch(T.tenantId, s.id)).toBe('dispatched');
      await deliverAll();
      expect(env.whatsapp.sent).toHaveLength(1);
      expect(env.whatsapp.sent[0].content.kind).toBe('template'); // no ordinary out-of-window send is attempted
      expect(env.whatsapp.texts(T.users.sam.id)[0]).toContain('daily_reminder');
      expect((await deliveries())[0].deferredPayload).not.toBeNull();
      // employee replies → window opens → detail is released exactly once
      expect(await outbound.flushDeferred(T.tenantId, T.users.sam.id, 'whatsapp')).toBe(1);
      expect(await outbound.flushDeferred(T.tenantId, T.users.sam.id, 'whatsapp')).toBe(0);
      await deliverAll();
      expect(env.whatsapp.sent).toHaveLength(2);
      expect(env.whatsapp.texts(T.users.sam.id)[1]).toContain('Call back');
    });
    it('inside the window the detailed digest is sent directly', async () => {
      const s = await dueDigest(); await digest.dispatch(T.tenantId, s.id); await deliverAll();
      expect(env.whatsapp.sent).toHaveLength(1);
      expect(env.whatsapp.sent[0].content.kind).toBe('reply');
    });
    it('template rejection and blocked delivery are recorded as failed and never retried or switched to free text', async () => {
      await db.systemTx((tx) => tx.execute(sql`update channel_bindings set last_inbound_at = now() - interval '30 hours'`));
      env.whatsapp.results.push({ kind: 'rejected', code: 'wa_132001', message: 'Template does not exist' });
      const s = await dueDigest(); await digest.dispatch(T.tenantId, s.id); await deliverAll(); await deliverAll();
      const [d] = await deliveries();
      expect(d.status).toBe('failed'); expect((d.errorInfo as any).code).toBe('wa_132001');
      expect(env.whatsapp.sent).toHaveLength(0);
    });
    it('an opted-out recipient receives nothing', async () => {
      await db.systemTx((tx) => tx.execute(sql`update channel_bindings set opted_out = true`));
      const s = await dueDigest(); await digest.dispatch(T.tenantId, s.id); await deliverAll();
      expect((await deliveries())[0]).toMatchObject({ status: 'failed' });
      expect(env.whatsapp.sent).toHaveLength(0);
    });
    it('an ambiguous send (timeout after the request was made) is held for reconciliation, not blindly retried (AT-09)', async () => {
      env.whatsapp.results.push({ kind: 'ambiguous', message: 'timeout' });
      const s = await dueDigest(); await digest.dispatch(T.tenantId, s.id); await deliverAll(); await deliverAll();
      expect((await deliveries())[0].status).toBe('ambiguous');
      expect(env.whatsapp.sent).toHaveLength(0); // second attempt did not resend
    });
    it('a revoked employee gets no outbound reminder even if it was already queued (IAM-05)', async () => {
      const s = await dueDigest(); await digest.dispatch(T.tenantId, s.id);
      await db.systemTx((tx) => tx.execute(sql`update users set status = 'revoked', revoked_at = now() where id = ${T.users.sam.id}`));
      await deliverAll();
      expect(env.whatsapp.sent).toHaveLength(0);
      expect((await deliveries())[0]).toMatchObject({ status: 'failed' });
    });
    it('delivery receipts update state separately from acceptance and never regress (WA-03)', async () => {
      const s = await dueDigest(); await digest.dispatch(T.tenantId, s.id); await deliverAll();
      const [d] = await deliveries(); expect(d.status).toBe('sent');
      await outbound.applyReceipt(d.externalMessageId!, 'read');
      await outbound.applyReceipt(d.externalMessageId!, 'delivered');
      expect((await deliveries())[0].status).toBe('read');
      await outbound.applyReceipt(d.externalMessageId!, 'failed', { code: 'x', message: 'boom' });
      expect((await deliveries())[0].status).toBe('failed');
    });
  });

  it('tasks edited in Twenty (not via chat) reach the next digest through reconciliation; completed and reassigned tasks drop out (AT-08)', async () => {
    const day = '2030-01-15'; // a Tuesday: deterministic working day
    const at = new Date('2030-01-15T02:00:00Z'); // 07:30 IST
    const dueAt = DateTime.fromISO(`${day}T00:00`, { zone: 'Asia/Kolkata' }).toUTC().toISO();
    await seedRecords(env, 'digest-co', { tasks: [task({ title: 'Edited in the UI', beeDueDate: day, dueAt, ...own('sam') }), task({ title: 'Will be completed', beeDueDate: day, dueAt, ...own('sam') }), task({ title: 'Will be reassigned', beeDueDate: day, dueAt, ...own('sam') })] });
    expect(await rows()).toHaveLength(0);
    await env.get(ReconciliationService).run(T.tenantId, at);
    // the digest for that day now exists without anyone using the chat assistant
    const [s] = (await rows()).filter((r) => r.userId === T.users.sam.id && r.localDate === day);
    expect(s).toBeTruthy();
    // the user completes one task and a manager reassigns another in the Twenty UI
    const t = ws.data.tasks;
    t[1].beeStatus = 'done'; t[1].status = 'DONE'; t[1].updatedAt = new Date(Date.now() + 1000).toISOString();
    t[2].beeOwnerMemberId = T.users.maya.memberId; t[2].updatedAt = new Date(Date.now() + 1000).toISOString();
    await makeDue(s.id);
    expect(await digest.dispatch(T.tenantId, s.id)).toBe('dispatched');
    await deliverAll();
    const text = env.whatsapp.texts(T.users.sam.id)[0];
    expect(text).toContain('Edited in the UI');
    expect(text).not.toContain('Will be completed');
    expect(text).not.toContain('Will be reassigned');
  });

  it('concurrent scheduler ticks over many digests claim each row exactly once (SKIP LOCKED)', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => crypto.randomUUID());
    await db.systemTx(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.insert(schedules).values({ id, tenantId: T.tenantId, userId: T.users.sam.id, type: 'digest', localDate: `2030-01-${String((i % 28) + 1).padStart(2, '0')}`, nextRunUtc: new Date(Date.now() - 60_000), timezone: 'UTC', idempotencyKey: `bulk/${i}` });
    });
    const claims = await Promise.all([scheduler.tick('a', 20), scheduler.tick('b', 20), scheduler.tick('c', 20)]);
    expect(claims.reduce((x, y) => x + y, 0)).toBe(120);
    expect((await rows()).filter((r) => r.state === 'claimed')).toHaveLength(120);
  });
});
