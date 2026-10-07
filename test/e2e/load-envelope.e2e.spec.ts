import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { WA_PHONE_ID, createTestEnv, waitFor, type TestEnv } from '../helpers/app';
import { seedRecords, seedTenant, waSign, type SeededTenant } from '../helpers/fixtures';
import { DbService } from '../../src/database/db.service';
import { SchedulerService } from '../../src/reminders/scheduler.service';
import { schedules, deliveryState } from '../../src/database/schema';
import { QueueService } from '../../src/queue/queue.service';

/**
 * Scaled version of the §10 load envelope against the real stack (Postgres, pg-boss, workers) with fake
 * external systems: 25 tenants × 25 users = 625 users; 20 events/s burst; synchronized 625-user morning batch.
 * Network latency to providers is excluded (as in the spec). Numbers are printed so they can be recorded.
 */
const TENANTS = 25; const USERS = 25;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

describe('load envelope (§10, AT-15)', () => {
  let env: TestEnv; let db: DbService; const tenants: SeededTenant[] = []; const phones: Array<{ phone: string; tenant: SeededTenant; key: string }> = [];

  beforeAll(async () => {
    env = await createTestEnv({ workers: false, config: { workers: { aiConcurrency: 8, crmConcurrency: 8, outboundConcurrency: 10, intakeConcurrency: 2, reminderConcurrency: 10, retryDelayMultiplier: 0.1 } } });
    db = env.get(DbService);
    const t0 = Date.now();
    for (let t = 0; t < TENANTS; t++) {
      const users = Array.from({ length: USERS }, (_, u) => ({ key: `u${u}`, displayName: `T${t} User ${u}`, role: 'salesperson' as const, phone: `+9190${String(t).padStart(2, '0')}${String(u).padStart(5, '0')}` }));
      const seeded = await seedTenant(env, { slug: `load-${t}`, users });
      tenants.push(seeded);
      for (const u of users) phones.push({ phone: u.phone, tenant: seeded, key: u.key });
    }
    console.log(`seeded ${TENANTS} tenants / ${phones.length} users in ${Date.now() - t0} ms`);
    await env.startWorkers();
  }, 300000);
  afterAll(async () => { await env.close(); });

  it('20 events/s for 20 s across 25 tenants: durable acceptance p95 < 2 s and every event is processed once', async () => {
    const SECONDS = 20; const RATE = 20; const lat: number[] = []; let n = 0;
    const start = Date.now();
    const fire = async (i: number) => {
      const p = phones[(i * 7) % phones.length];
      const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: WA_PHONE_ID }, messages: [{ id: `load-${i}`, from: p.phone.replace('+', ''), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'help' } }] } }] }] });
      const t = performance.now();
      const r = await env.app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': waSign(raw) }, payload: raw });
      lat.push(performance.now() - t);
      expect(r.statusCode).toBe(200);
    };
    const inflight: Promise<void>[] = [];
    for (let s = 0; s < SECONDS; s++) {
      const tick = Date.now();
      for (let k = 0; k < RATE; k++) inflight.push(fire(n++));
      const wait = 1000 - (Date.now() - tick);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    await Promise.all(inflight);
    const sendDuration = Date.now() - start;
    await waitFor(() => env.whatsapp.sent.length >= n || undefined, 60000, 200, 'all events answered');
    const drain = Date.now() - start;
    const depth = await env.get<QueueService>(QueueService).stats();
    console.log(`BURST events=${n} accept p50=${pct(lat, 50).toFixed(0)}ms p95=${pct(lat, 95).toFixed(0)}ms p99=${pct(lat, 99).toFixed(0)}ms max=${Math.max(...lat).toFixed(0)}ms sendWindow=${sendDuration}ms fullyProcessed=${drain}ms queues=${JSON.stringify(depth.map((d) => [d.queue, d.queued]))}`);
    expect(pct(lat, 95)).toBeLessThan(2000);
    expect(env.whatsapp.sent.length).toBe(n); // exactly one reply per event: nothing lost or duplicated
  }, 180000);

  it('synchronized morning batch: 625 digests claimed, built from live CRM data and submitted once each', async () => {
    env.whatsapp.clear();
    await db.systemTx((tx) => tx.execute(sql`delete from delivery_state`));
    const day = '2030-01-15'; const dueAt = '2030-01-14T18:30:00.000Z';
    for (const t of tenants) await seedRecords(env, `load-${tenants.indexOf(t)}`, { tasks: Object.values(t.users).map((u) => ({ title: `Task for ${u.ownerKey}`, beeStatus: 'open', status: 'TODO', beeTaskKind: 'follow_up', beeHasTime: false, beeDueDate: day, dueAt, beeOwnerMemberId: u.ownerKey })) });
    const rows = tenants.flatMap((t) => Object.values(t.users).map((u) => ({ tenantId: t.tenantId, userId: u.id, type: 'digest', localDate: day, nextRunUtc: new Date(Date.now() - 30_000), timezone: 'Asia/Kolkata', idempotencyKey: `${t.tenantId}/${u.id}/${day}/morning` })));
    for (let i = 0; i < rows.length; i += 100) await db.systemTx((tx) => tx.insert(schedules).values(rows.slice(i, i + 100)));
    const t0 = Date.now();
    const claimed = await env.get<SchedulerService>(SchedulerService).tick('load-scheduler');
    expect(claimed).toBe(625);
    const states = async () => Object.fromEntries((await db.systemTx((tx) => tx.execute(sql`select state, count(*)::int as n from schedules group by state`))).map((r: any) => [r.state, r.n]));
    await waitFor(async () => ((await states()).dispatched ?? 0) === 625 || undefined, 240000, 500, 'all 625 digests dispatched');
    const dispatched = Date.now() - t0;
    await waitFor(() => env.whatsapp.sent.length >= 625 || undefined, 120000, 500, 'all digests delivered to the provider');
    const all = Date.now() - t0;
    const del = await db.systemTx((tx) => tx.select().from(deliveryState));
    const perTenantCalls = env.twenty.workspaces.get('load-0')!.calls.length;
    console.log(`MORNING 625 users: dispatched in ${dispatched}ms, submitted to provider in ${all}ms (target: 99% within 10 min = 600000ms); twenty calls for one workspace=${perTenantCalls}`);
    expect(all).toBeLessThan(10 * 60_000);
    expect(del).toHaveLength(625); expect(env.whatsapp.sent).toHaveLength(625);
    expect(new Set(del.map((d) => d.idempotencyKey)).size).toBe(625); // each intended digest exactly once
    expect(env.whatsapp.texts(phones[0].tenant.users[phones[0].key].id)[0]).toContain(`Task for ${phones[0].tenant.users[phones[0].key].ownerKey}`);
  }, 360000);
});
