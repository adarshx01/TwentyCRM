import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../helpers/app';
import { CAPTURE, loadOp, makeOperation, seedTenant, type SeededTenant } from '../helpers/fixtures';
import { OperationJournal } from '../../src/crm/operations/operation-journal.service';
import { DbService } from '../../src/database/db.service';
import { operations } from '../../src/database/schema';
import { eq, sql } from 'drizzle-orm';
import { RetryLaterError } from '../../src/common/errors';

describe('operation journal: partial failures and restarts (ACT-04, ACT-05, AT-13)', () => {
  let env: TestEnv; let T: SeededTenant; let journal: OperationJournal; let ws: ReturnType<TestEnv['twenty']['addWorkspace']>;

  beforeAll(async () => {
    env = await createTestEnv();
    T = await seedTenant(env, { slug: 'journal-co', users: [{ key: 'sam', displayName: 'Sam', role: 'salesperson', phone: '+919800000001' }] });
    journal = env.get(OperationJournal);
    ws = env.twenty.workspaces.get('journal-co')!;
  });
  afterAll(async () => { await env.close(); });
  beforeEach(() => { for (const k of Object.keys(ws.data)) ws.data[k] = []; env.twenty.injections = []; });

  const counts = () => ({ people: ws.all('people').length, companies: ws.all('companies').length, opps: ws.all('opportunities').length, notes: ws.all('notes').length, tasks: ws.all('tasks').length });
  const expectOnce = () => expect(counts()).toEqual({ people: 1, companies: 1, opps: 1, notes: 1, tasks: 1 });

  it('happy path commits every step once, with stable operation keys on each record', async () => {
    const op = await makeOperation(env, T, 'sam', CAPTURE);
    const out = await journal.execute(T.tenantId, op.id, 'w1');
    expect(out.status).toBe('committed');
    expectOnce();
    const keys = [...ws.all('people'), ...ws.all('companies'), ...ws.all('opportunities'), ...ws.all('notes'), ...ws.all('tasks')].map((r) => r.beeOperationKey);
    expect(keys.every((k) => k.startsWith(`${op.id}:`))).toBe(true);
  });

  it('Twenty times out AFTER a successful create → retry finds the record by operation key, no duplicate (AT-13)', async () => {
    env.twenty.inject({ match: (m, p) => m === 'POST' && p === '/rest/opportunities', mode: 'hang_after_apply', times: 1 });
    const op = await makeOperation(env, T, 'sam', CAPTURE);
    await expect(journal.execute(T.tenantId, op.id, 'w1')).rejects.toThrow(/Twenty request failed/); // client timeout
    expect(ws.all('opportunities')).toHaveLength(1); // it WAS created on the server
    const mid = await loadOp(env, T, op.id);
    expect(mid.state).toBe('in_progress');
    const steps = mid.steps as any[];
    expect(steps.find((s) => s.key === 'opportunity').status).toBe('in_progress'); // outcome unknown, journaled as such
    expect(steps.find((s) => s.key === 'company').status).toBe('committed');
    expect(steps.find((s) => s.key === 'note:0').status).toBe('pending');
    // Retry by the same worker (lease still ours) resumes only the missing steps.
    const out = await journal.execute(T.tenantId, op.id, 'w1');
    expect(out.status).toBe('committed');
    expectOnce();
  });

  it('a worker that died mid-operation is replaced by another worker after the lease expires; committed steps are not repeated', async () => {
    env.twenty.inject({ match: (m, p) => m === 'POST' && p === '/rest/notes', mode: 'status', status: 503, times: 1 });
    const op = await makeOperation(env, T, 'sam', CAPTURE);
    await expect(journal.execute(T.tenantId, op.id, 'worker-A')).rejects.toThrow();
    const callsBefore = ws.calls.filter((c) => c.method === 'POST').length;
    // Another worker cannot steal a live lease…
    await expect(journal.execute(T.tenantId, op.id, 'worker-B')).rejects.toBeInstanceOf(RetryLaterError);
    // …but takes over once worker-A's lease has expired (process killed).
    await env.get<DbService>(DbService).tenantTx(T.tenantId, (tx) => tx.update(operations).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(operations.id, op.id)));
    const out = await journal.execute(T.tenantId, op.id, 'worker-B');
    expect(out.status).toBe('committed');
    expectOnce();
    const posts = ws.calls.filter((c) => c.method === 'POST').slice(callsBefore).map((c) => c.path);
    expect(posts).not.toContain('/rest/people'); expect(posts).not.toContain('/rest/companies'); expect(posts).not.toContain('/rest/opportunities');
    expect((await loadOp(env, T, op.id)).state).toBe('committed');
  });

  it('two workers racing for one operation produce one set of records', async () => {
    const op = await makeOperation(env, T, 'sam', CAPTURE);
    const results = await Promise.allSettled([journal.execute(T.tenantId, op.id, 'A'), journal.execute(T.tenantId, op.id, 'B'), journal.execute(T.tenantId, op.id, 'C')]);
    expect(results.filter((r) => r.status === 'fulfilled' && (r.value as any).status === 'committed')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(RetryLaterError);
    expectOnce();
  });

  it('re-delivering a finished operation is a no-op', async () => {
    const op = await makeOperation(env, T, 'sam', CAPTURE);
    await journal.execute(T.tenantId, op.id, 'w1');
    const posts = ws.calls.length;
    expect((await journal.execute(T.tenantId, op.id, 'w2')).status).toBe('noop');
    expect(ws.calls.length).toBe(posts);
    expectOnce();
  });

  it('the same idempotency key yields the same operation (duplicate confirmation)', async () => {
    const a = await makeOperation(env, T, 'sam', CAPTURE, 'same-key');
    const b = await makeOperation(env, T, 'sam', CAPTURE, 'same-key');
    expect(b.id).toBe(a.id);
  });

  it('a permanent Twenty rejection after partial progress → needs_repair, reports exactly what was saved, never deletes', async () => {
    env.twenty.inject({ match: (m, p) => m === 'POST' && p === '/rest/tasks', mode: 'status', status: 400, times: 5 });
    const op = await makeOperation(env, T, 'sam', CAPTURE);
    const out = await journal.execute(T.tenantId, op.id, 'w1');
    expect(out.status).toBe('needs_repair');
    const row = await loadOp(env, T, op.id);
    expect(row.state).toBe('needs_repair');
    const progress = OperationJournal.describeProgress(row);
    expect(progress.saved).toEqual(expect.arrayContaining(['contact', 'company', 'opportunity', 'note']));
    expect(progress.failed).toEqual(['task']);
    // Partial records stay (auditable); nothing was rolled back or deleted.
    expect(counts()).toMatchObject({ people: 1, companies: 1, opps: 1, notes: 1, tasks: 0 });
  });

  it('a revoked user\'s pending operation is stopped before any write (AT-14)', async () => {
    const op = await makeOperation(env, T, 'sam', CAPTURE);
    await env.get<DbService>(DbService).systemTx((tx) => tx.execute(sql`update users set status = 'revoked', revoked_at = now() where id = ${T.users.sam.id}`));
    const out = await journal.execute(T.tenantId, op.id, 'w1');
    expect(out.status).toBe('revoked');
    expect(counts()).toEqual({ people: 0, companies: 0, opps: 0, notes: 0, tasks: 0 });
    await env.get<DbService>(DbService).systemTx((tx) => tx.execute(sql`update users set status = 'active', revoked_at = null where id = ${T.users.sam.id}`));
  });

  it('Twenty rate limiting (429 + Retry-After) defers the job instead of failing it', async () => {
    env.twenty.inject({ match: () => true, mode: 'status', status: 429, times: 1 });
    const op = await makeOperation(env, T, 'sam', CAPTURE);
    await expect(journal.execute(T.tenantId, op.id, 'w1')).rejects.toBeInstanceOf(RetryLaterError);
    expect((await loadOp(env, T, op.id)).state).toBe('in_progress');
    expect((await journal.execute(T.tenantId, op.id, 'w1')).status).toBe('committed');
    expectOnce();
  });
});
