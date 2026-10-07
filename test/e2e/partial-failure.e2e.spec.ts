import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ADMIN_KEY, createTestEnv, waitFor, type TestEnv } from '../helpers/app';
import { confirmLast, seedTenant, talk, type SeededTenant } from '../helpers/fixtures';
import { DbService } from '../../src/database/db.service';
import { deadLetters, drafts, operations } from '../../src/database/schema';

const PHONE = '+919800000001';
const AT = { receivedAt: '2026-09-28T04:30:00.000Z' };

describe('partial failure and recovery through the real queue (AT-13, ACT-05, CAP-08)', () => {
  let env: TestEnv; let T: SeededTenant; let ws: any; let db: DbService; let n = 0;
  beforeAll(async () => {
    env = await createTestEnv({ workers: true });
    T = await seedTenant(env, { slug: 'pf-co', users: [{ key: 'sam', displayName: 'Sam', role: 'salesperson', phone: PHONE }] });
    ws = env.twenty.workspaces.get('pf-co'); db = env.get(DbService);
  });
  afterAll(async () => { await env.close(); });

  const startCapture = async () => {
    const name = `Lead${++n}`;
    env.extraction.when(new RegExp(`new lead ${name}`, 'i'), { intent: 'capture_lead', person: { name: `${name} Test`, email: `${name.toLowerCase()}@x.example`, companyName: `${name} Corp` }, tasks: [{ title: 'Call back', type: 'follow_up', dateExpression: 'next Tuesday' }], confidence: 0.9 });
    await talk(env, T, 'sam', `new lead ${name}`, AT);
    return name;
  };
  const counts = () => ({ people: ws.all('people').length, companies: ws.all('companies').length, opps: ws.all('opportunities').length, notes: ws.all('notes').length, tasks: ws.all('tasks').length });

  it('Twenty times out after creating the opportunity: the queue retries, no duplicate, user told the truth', async () => {
    const name = await startCapture();
    const base = counts();
    env.twenty.inject({ match: (m, p) => m === 'POST' && p === '/rest/opportunities', mode: 'hang_after_apply', times: 1 });
    const texts = await confirmLast(env, T, 'sam');
    expect(texts.join('\n')).toMatch(/✅ Saved/);
    expect(counts()).toEqual({ people: base.people + 1, companies: base.companies + 1, opps: base.opps + 1, notes: base.notes + 1, tasks: base.tasks + 1 });
    expect(ws.all('opportunities').filter((o: any) => o.name.startsWith(`${name} Test`))).toHaveLength(1);
    const [op] = await db.tenantTx(T.tenantId, (tx) => tx.select().from(operations).where(eq(operations.type, 'capture_lead')));
    expect(op.state).toBe('committed');
    expect(op.retryCount).toBeGreaterThanOrEqual(1);
  }, 60000);

  it('it never announces complete success before all confirmed actions finish (CAP-08)', async () => {
    await startCapture();
    env.twenty.inject({ match: (m, p) => m === 'POST' && p === '/rest/tasks', mode: 'status', status: 503, times: 2 });
    const before = env.whatsapp.texts(T.users.sam.id).length;
    await confirmLast(env, T, 'sam');
    const all = env.whatsapp.texts(T.users.sam.id).slice(before);
    const savedIdx = all.findIndex((t) => /✅ Saved/.test(t));
    const progressIdx = all.findIndex((t) => /Still saving/.test(t));
    expect(progressIdx).toBeGreaterThanOrEqual(0);              // interim "what is saved / what is retrying"
    expect(progressIdx).toBeLessThan(savedIdx);                 // success only after the last step
    expect(all[progressIdx]).toMatch(/Saved so far:.*contact/s);
    expect(all[progressIdx]).toMatch(/Retrying:.*task/s);
  }, 60000);

  it('a permanent rejection of the last step ends in needs_repair and says exactly what was saved', async () => {
    await startCapture();
    env.twenty.inject({ match: (m, p) => m === 'POST' && p === '/rest/tasks', mode: 'status', status: 400, times: 10 });
    const texts = await confirmLast(env, T, 'sam');
    const msg = texts.join('\n');
    expect(msg).toMatch(/Part of this could not be completed/);
    const saved = /Saved: ([^\n]*)/.exec(msg)![1];
    for (const part of ['contact', 'company', 'opportunity', 'note']) expect(saved).toContain(part);
    expect(saved).not.toContain('task');
    expect(msg).toMatch(/Needs attention: task/);
    const d = (await db.tenantTx(T.tenantId, (tx) => tx.select().from(drafts))).filter((x) => x.state === 'needs_repair');
    expect(d.length).toBe(1);
    // the operator replays: only the missing step runs, nothing is duplicated
    env.twenty.injections = [];
    const base = counts();
    const letters = await waitFor(async () => { const r = await env.app.inject({ method: 'GET', url: '/admin/dead-letters', headers: { 'x-api-key': ADMIN_KEY } }); const j = r.json(); return j.length ? j : null; }, 15000, 200, 'dead letter listed');
    expect(letters[0].queue).toBe('crm-write');
    expect(JSON.stringify(letters)).not.toMatch(/Bearer|token/i);
    const retried = await env.app.inject({ method: 'POST', url: `/admin/dead-letters/${letters[0].id}/retry`, headers: { 'x-api-key': ADMIN_KEY } });
    expect(retried.json()).toEqual({ status: 'requeued' });
    await waitFor(async () => (await db.tenantTx(T.tenantId, (tx) => tx.select().from(operations).where(eq(operations.state, 'committed')))).length >= 3 ? true : null, 30000, 200, 'repaired op committed');
    expect(counts()).toEqual({ ...base, tasks: base.tasks + 1 });
    expect((await db.systemTx((tx) => tx.select().from(deadLetters).where(sql`resolved_at is null`)))).toHaveLength(0);
  }, 90000);

  it('Twenty down for every attempt: retries are exhausted, the item is dead-lettered and the user is told it needs attention', async () => {
    const name = await startCapture();
    const base = counts();
    env.twenty.inject({ match: () => true, mode: 'status', status: 503, times: 1000 });
    const before = env.whatsapp.texts(T.users.sam.id).length;
    const { buttonId, lastWithButtons, pressButton } = await import('../helpers/fixtures');
    await pressButton(env, PHONE, buttonId(lastWithButtons(env, T.users.sam.id), 'Confirm'));
    await waitFor(() => env.whatsapp.texts(T.users.sam.id).slice(before).some((t) => /couldn't save|could not be completed/.test(t)), 60000, 300, 'failure message');
    expect(counts()).toEqual(base); // nothing written, nothing duplicated
    const [op] = (await db.tenantTx(T.tenantId, (tx) => tx.select().from(operations))).slice(-1);
    expect(['failed', 'needs_repair']).toContain(op.state);
    env.twenty.injections = [];
    void name;
  }, 120000);
});
