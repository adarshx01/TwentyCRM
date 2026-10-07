import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestEnv, type TestEnv } from '../helpers/app';
import { seedTenant, type SeededTenant } from '../helpers/fixtures';
import { DbService } from '../../src/database/db.service';
import { MaintenanceService } from '../../src/maintenance/maintenance.service';
import { DraftService } from '../../src/conversation/draft.service';
import { emptyCapture } from '../../src/conversation/draft.types';
import { auditLog, drafts, idempotencyKeys, inboundEvents } from '../../src/database/schema';
import { QueueService } from '../../src/queue/queue.service';
import { WorkersService } from '../../src/workers/workers.service';

describe('retention and scheduler wiring (SEC-04, §11)', () => {
  let env: TestEnv; let T: SeededTenant; let db: DbService; let m: MaintenanceService;
  beforeAll(async () => {
    env = await createTestEnv();
    T = await seedTenant(env, { slug: 'maint-co', users: [{ key: 'sam', displayName: 'Sam', role: 'salesperson', phone: '+919800000001' }] });
    db = env.get(DbService); m = env.get(MaintenanceService);
  });
  afterAll(async () => { await env.close(); });

  it('unconfirmed drafts expire 30 minutes after the latest edit and write nothing', async () => {
    const ds = env.get<DraftService>(DraftService);
    const d = await ds.create({ tenantId: T.tenantId, userId: T.users.sam.id, conversationId: 'c', channel: 'whatsapp', kind: 'capture', data: emptyCapture('new') });
    expect((d.expiresAt!.getTime() - Date.now()) / 60_000).toBeGreaterThan(29);
    expect((await m.frequent(new Date(Date.now() + 29 * 60_000))).draftsExpired).toBe(0);
    await ds.mutate(T.tenantId, d.id, () => ({ data: emptyCapture('new'), bumpVersion: true })); // an edit extends the deadline
    expect((await m.frequent(new Date(Date.now() + 29 * 60_000))).draftsExpired).toBe(0);
    expect((await m.frequent(new Date(Date.now() + 31 * 60_000))).draftsExpired).toBe(1);
    expect((await db.tenantTx(T.tenantId, (tx) => tx.select().from(drafts)))[0].state).toBe('expired');
  });

  it('terminal draft states never move again (DB-enforced)', async () => {
    const [row] = await db.tenantTx(T.tenantId, (tx) => tx.select().from(drafts));
    let err = ''; try { await db.tenantTx(T.tenantId, (tx) => tx.execute(sql`update drafts set state = 'awaiting_confirmation' where id = ${row.id}`)); } catch (e: any) { err = `${e.message} ${e.cause?.message}`; }
    expect(err).toMatch(/is terminal/);
  });

  it('hourly cleanup purges expired idempotency keys and old webhook events', async () => {
    await db.tenantTx(T.tenantId, (tx) => tx.insert(idempotencyKeys).values({ key: 'old-key', tenantId: T.tenantId, expiresAt: new Date(Date.now() - 1000) }));
    await db.systemTx((tx) => tx.insert(inboundEvents).values({ providerEventId: 'old-evt', channel: 'whatsapp', createdAt: new Date(Date.now() - 20 * 86_400_000) }));
    const r = await m.hourly();
    expect(r.idempotencyKeys).toBeGreaterThanOrEqual(1); expect(r.inboundEvents).toBeGreaterThanOrEqual(1);
  });

  it('audit records are kept for the retention period and removed only by the purge job (12 months)', async () => {
    await db.tenantTx(T.tenantId, async (tx) => {
      await tx.insert(auditLog).values({ tenantId: T.tenantId, action: 'recent.keep' });
      await tx.insert(auditLog).values({ tenantId: T.tenantId, action: 'ancient.purge', timestamp: new Date(Date.now() - 400 * 86_400_000) });
    });
    const out = await m.daily();
    expect(out.audit).toBe(1);
    const left = (await db.tenantTx(T.tenantId, (tx) => tx.select().from(auditLog))).map((a) => a.action);
    expect(left).toContain('recent.keep'); expect(left).not.toContain('ancient.purge');
  });

  it('per-tenant usage telemetry is available to operators without exposing content (§11)', async () => {
    const { ADMIN_KEY } = await import('../helpers/app');
    await db.tenantTx(T.tenantId, (tx) => tx.execute(sql`insert into usage_events (tenant_id, kind, quantity, provider) values (${T.tenantId}, 'llm_tokens', 1200, 'fake'), (${T.tenantId}, 'stt_seconds', 45, 'fake')`));
    const r = await env.app.inject({ method: 'GET', url: `/admin/tenants/${T.tenantId}/usage?days=7`, headers: { 'x-api-key': ADMIN_KEY } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.usage.find((u: any) => u.kind === 'llm_tokens').total).toBe('1200');
    expect(body.usage.find((u: any) => u.kind === 'stt_seconds').total).toBe('45');
  });

  it('the scheduler role registers its cron producers and consumers without error', async () => {
    const q = env.get<QueueService>(QueueService);
    await q.stop(500).catch(() => undefined);
    await q.start({ supervise: false, schedule: true });
    await env.get<WorkersService>(WorkersService).startScheduler();
    await env.get<WorkersService>(WorkersService).startScheduler(); // idempotent: a second scheduler process changes nothing
    const ids = await q.schedulers();
    for (const n of ['schedule-tick', 'schedule-planner', 'maint-frequent', 'maint-hourly', 'maint-daily', 'fanout-reconcile', 'fanout-mailbox']) expect(ids).toContain(`cron-${n}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
