import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, waitFor, type TestEnv } from '../helpers/app';
import { CAPTURE, loadOp, makeOperation, pressButton, buttonId, lastWithButtons, seedTenant, sendMedia, sendText, talk, type SeededTenant } from '../helpers/fixtures';
import { cardImage } from '../helpers/fakes';
import { DbService } from '../../src/database/db.service';
import { QueueService } from '../../src/queue/queue.service';
import { QUEUES } from '../../src/queue/queues';
import { operations } from '../../src/database/schema';

const AT = { receivedAt: '2026-09-28T04:30:00.000Z' };

describe('concurrency, protection of Twenty, and fairness (ACT-03, SYNC-04, TEN-05, §10)', () => {
  let env: TestEnv; let A: SeededTenant; let B: SeededTenant; let wsA: any; let wsB: any; let db: DbService;
  const phoneOf = (i: number) => `+9198000${String(10000 + i).slice(1)}`;

  beforeAll(async () => {
    env = await createTestEnv({ workers: true, twentyRateLimit: 1_000_000 });
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `u${i}`, displayName: `User ${i}`, role: 'salesperson' as const, phone: phoneOf(i) }));
    A = await seedTenant(env, { slug: 'conc-a', users: many });
    B = await seedTenant(env, { slug: 'conc-b', users: [{ key: 'bob', displayName: 'Bob', role: 'salesperson', phone: '+919899990001' }] });
    wsA = env.twenty.workspaces.get('conc-a'); wsB = env.twenty.workspaces.get('conc-b'); db = env.get(DbService);
  });
  afterAll(async () => { await env.close(); });

  it('simultaneous confirm clicks (same draft, same version) produce exactly one operation and one record set (ACT-03, ACT-05)', async () => {
    env.extraction.when(/new lead Racer/, { intent: 'capture_lead', person: { name: 'Race Condition', email: 'race@x.example', companyName: 'Racing Ltd' }, confidence: 0.9 });
    await talk(env, A, 'u0', 'new lead Racer', AT);
    const confirm = buttonId(lastWithButtons(env, A.users.u0.id), 'Confirm');
    await Promise.all(Array.from({ length: 8 }, () => pressButton(env, A.users.u0.phone!, confirm)));
    await waitFor(() => wsA.all('opportunities').length === 1 && env.whatsapp.texts(A.users.u0.id).some((t) => /✅ Saved/.test(t)), 30000, 100, 'saved');
    await new Promise((r) => setTimeout(r, 1500));
    expect(wsA.all('people')).toHaveLength(1); expect(wsA.all('companies')).toHaveLength(1); expect(wsA.all('opportunities')).toHaveLength(1);
    expect((await db.tenantTx(A.tenantId, (tx) => tx.select().from(operations)))).toHaveLength(1);
  });

  it('many users capturing at once all succeed, each into their own records, with no cross-talk', async () => {
    const before = wsA.all('opportunities').length;
    for (let i = 1; i < 12; i++) env.extraction.when(new RegExp(`new lead Parallel${i}$`), { intent: 'capture_lead', person: { name: `Parallel ${i}`, email: `p${i}@x.example`, companyName: `Same Company` }, confidence: 0.9 });
    await Promise.all(Array.from({ length: 11 }, (_, k) => talk(env, A, `u${k + 1}`, `new lead Parallel${k + 1}`, AT, 600)));
    await Promise.all(Array.from({ length: 11 }, (_, k) => pressButton(env, A.users[`u${k + 1}`].phone!, buttonId(lastWithButtons(env, A.users[`u${k + 1}`].id), 'Confirm'))));
    await waitFor(() => wsA.all('opportunities').length === before + 11, 60000, 200, 'all 11 captures committed');
    const mine = wsA.all('people').filter((p: any) => /^Parallel/.test(p.name.firstName));
    expect(mine).toHaveLength(11);
    for (let i = 1; i <= 11; i++) {
      const p = mine.find((x: any) => x.name.lastName === String(i)) ?? mine.find((x: any) => x.name.firstName === 'Parallel' && x.emails.primaryEmail === `p${i}@x.example`);
      expect(p.beeOwnerMemberId).toBe(A.users[`u${i}`].ownerKey);
    }
    expect(wsB.all('people')).toHaveLength(0);
  });

  it('protects Twenty: at most 2 concurrent write operations per workspace even under a backlog of jobs', async () => {
    env.twenty.latencyMs = 120; env.twenty.maxInflight = 0;
    const queue = env.get<QueueService>(QueueService);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const op = await makeOperation(env, A, 'u0', { ...CAPTURE, person: { name: `Backlog ${i}`, email: `b${i}@x.example` }, company: { name: `Backlog Co ${i}` } } as any);
      ids.push(op.id);
      await queue.send(QUEUES.CRM_WRITE, { operationId: op.id }, { tenantId: A.tenantId, userId: A.users.u0.id, idempotencyKey: `crm:${op.id}` });
    }
    await waitFor(async () => (await Promise.all(ids.map((id) => loadOp(env, A, id)))).every((o) => o.state === 'committed'), 90000, 300, 'backlog drained');
    expect(env.twenty.maxInflight).toBeLessThanOrEqual(2);
    expect(env.twenty.maxInflight).toBeGreaterThanOrEqual(1);
    env.twenty.latencyMs = 0;
  }, 120000);

  it('respects the per-workspace request budget: with a server limit of 100/min the client never triggers a 429 (SYNC-04)', async () => {
    const e2 = await createTestEnv({ workers: true, twentyRateLimit: 100, config: { twenty: { apiUrl: '', rateLimit: 80, timeoutMs: 1500, maxConcurrentWrites: 2 } } });
    try {
      // apiUrl is overridden per tenant (baseUrl) by seedTenant, so only the budget matters here
      const T = await seedTenant(e2, { slug: 'budget-co', users: [{ key: 'sam', displayName: 'Sam', role: 'salesperson', phone: '+919800000001' }] });
      const base = e2.twenty.requestCount;
      const queue = e2.get<QueueService>(QueueService);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const op = await makeOperation(e2, T, 'sam', { ...CAPTURE, person: { name: `Budget ${i}` }, company: { name: `Budget Co ${i}` } } as any);
        ids.push(op.id);
        await queue.send(QUEUES.CRM_WRITE, { operationId: op.id }, { tenantId: T.tenantId, userId: T.users.sam.id, idempotencyKey: `crm:${op.id}` });
      }
      await waitFor(async () => (await Promise.all(ids.map((id) => loadOp(e2, T, id)))).every((o) => o.state === 'committed'), 90000, 300, 'committed within budget');
      expect(e2.twenty.rateLimited).toBe(0);
      expect(e2.twenty.requestCount - base).toBeGreaterThan(20);
    } finally { await e2.close(); }
  }, 120000);

  it('fairness: one client flooding uploads and messages cannot starve another client (TEN-05)', async () => {
    env.extraction.cards.set('flood', { name: 'Flood Card', phones: [], legible: true, uncertainFields: [] });
    env.media.files.set('floodimg', { data: cardImage('flood'), mimeType: 'image/png' });
    env.extraction.when(/ping from bob/, { intent: 'smalltalk' });
    // tenant A floods: 60 card uploads and 150 chat messages in a burst
    const flood = Promise.all([
      ...Array.from({ length: 60 }, (_, i) => sendMedia(env, phoneOf(i % 12), 'image', 'floodimg', 'image/png', { conversationId: `flood-${i}` })),
      ...Array.from({ length: 150 }, (_, i) => sendText(env, phoneOf(i % 12), `noise ${i}`)),
    ]);
    const t0 = Date.now();
    await sendText(env, B.users.bob.phone!, 'help');
    await flood;
    await waitFor(() => env.whatsapp.texts(B.users.bob.id).some((t) => /What I can do/.test(t)), 20000, 100, 'bob answered');
    const latency = Date.now() - t0;
    expect(latency).toBeLessThan(15000);
    // uploads beyond the tenant quota are refused with a friendly message instead of piling up
    await waitFor(() => env.whatsapp.sent.some((m) => m.target.tenantId === A.tenantId && /Too many uploads/.test(m.content.kind === 'reply' ? m.content.text : '')), 30000, 200, 'upload quota message');
    const c = await env.get<QueueService>(QueueService).counts(QUEUES.AI_EXTRACTION);
    expect(c.waiting + c.active + c.delayed).toBeLessThanOrEqual(30); // never more than the per-minute quota of uploads queued
  }, 90000);
});
