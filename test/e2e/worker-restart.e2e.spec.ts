import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestEnv, waitFor, type TestEnv } from '../helpers/app';
import { CAPTURE, loadOp, makeOperation, seedTenant, type SeededTenant } from '../helpers/fixtures';
import { DbService } from '../../src/database/db.service';
import { QueueService } from '../../src/queue/queue.service';
import { QUEUES } from '../../src/queue/queues';
import { WorkersService } from '../../src/workers/workers.service';
import { operations } from '../../src/database/schema';

describe('worker restart mid-operation (AT-13, §10 reliability)', () => {
  let env: TestEnv; let T: SeededTenant; let ws: any; let db: DbService;
  beforeAll(async () => {
    env = await createTestEnv({ workers: true });
    T = await seedTenant(env, { slug: 'restart-co', users: [{ key: 'sam', displayName: 'Sam', role: 'salesperson', phone: '+919800000001' }] });
    ws = env.twenty.workspaces.get('restart-co'); db = env.get(DbService);
  });
  afterAll(async () => { await env.close(); });

  it('kills the worker while a multi-step write is in flight; a fresh worker resumes and finishes with no duplicates', async () => {
    const queue = env.get<QueueService>(QueueService);
    const op = await makeOperation(env, T, 'sam', CAPTURE);
    // The process "dies" while creating the opportunity: person + company exist, the rest does not.
    env.twenty.inject({ match: (m, p) => m === 'POST' && p === '/rest/opportunities', mode: 'hang_before_apply', times: 1 });
    await queue.send(QUEUES.CRM_WRITE, { operationId: op.id }, { tenantId: T.tenantId, userId: T.users.sam.id, idempotencyKey: `crm:${op.id}` });
    await waitFor(async () => ((await loadOp(env, T, op.id)).steps as any[]).find((s) => s.key === 'opportunity')?.status === 'in_progress', 15000, 100, 'opportunity step in flight');
    expect(ws.all('people')).toHaveLength(1); expect(ws.all('opportunities')).toHaveLength(0);

    // Hard stop: no graceful drain (SIGKILL-like). The old in-process handler is left to die on its own timeout.
    await queue.stop(200, false);
    await new Promise((r) => setTimeout(r, 2200)); // let the orphaned handler finish failing; it holds no authority any more
    // The job was claimed by the dead worker; its operation lease expires too.
    // BullMQ's stalled-job check returns the dead worker's job once its lock lapses (lockDuration 4 s in tests).
    await db.tenantTx(T.tenantId, (tx) => tx.update(operations).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(operations.id, op.id)));

    // A brand-new worker process starts.
    await queue.start({ supervise: false, schedule: false });
    await env.get<WorkersService>(WorkersService).startWorkers();
    await waitFor(async () => (await loadOp(env, T, op.id)).state === 'committed', 30000, 200, 'resumed operation committed');

    expect(ws.all('people')).toHaveLength(1);
    expect(ws.all('companies')).toHaveLength(1);
    expect(ws.all('opportunities')).toHaveLength(1);
    expect(ws.all('notes')).toHaveLength(1);
    expect(ws.all('tasks')).toHaveLength(1);
    const final = await loadOp(env, T, op.id);
    expect((final.steps as any[]).every((s) => s.status === 'committed')).toBe(true);
    expect(final.leaseOwner).toBeNull();
  }, 90000);

  it('graceful shutdown lets in-flight jobs finish, and queued jobs survive for the next process', async () => {
    const queue = env.get<QueueService>(QueueService);
    const ops = [] as string[];
    for (let i = 0; i < 3; i++) {
      const o = await makeOperation(env, T, 'sam', { ...CAPTURE, person: { name: `Graceful ${i}`, email: `g${i}@x.example` }, company: { name: `Graceful Co ${i}` } } as any);
      ops.push(o.id);
      await queue.send(QUEUES.CRM_WRITE, { operationId: o.id }, { tenantId: T.tenantId, userId: T.users.sam.id, idempotencyKey: `crm:${o.id}` });
    }
    await queue.stop(20_000, true); // graceful drain
    // whatever did not run yet is still durable in Postgres
    await queue.start({ supervise: false, schedule: false });
    await env.get<WorkersService>(WorkersService).startWorkers();
    await waitFor(async () => (await Promise.all(ops.map((id) => loadOp(env, T, id)))).every((o) => o.state === 'committed'), 40000, 200, 'all committed');
    expect(ws.all('people').filter((p: any) => String(p.name.firstName).startsWith('Graceful'))).toHaveLength(3);
  }, 90000);
});
