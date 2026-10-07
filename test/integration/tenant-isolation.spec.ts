import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestEnv, type TestEnv } from '../helpers/app';
import { seedTenant, type SeededTenant } from '../helpers/fixtures';
import { DbService } from '../../src/database/db.service';
import { auditLog, drafts, users } from '../../src/database/schema';
import { DraftService } from '../../src/conversation/draft.service';
import { emptyCapture } from '../../src/conversation/draft.types';
import { IdentityService } from '../../src/identity/identity.service';

describe('tenant isolation (TEN-03, AT-01)', () => {
  let env: TestEnv; let A: SeededTenant; let B: SeededTenant; let db: DbService;

  beforeAll(async () => {
    env = await createTestEnv();
    A = await seedTenant(env, { slug: 'client-a', users: [{ key: 'sam', displayName: 'Sam', role: 'salesperson', phone: '+919800000001' }] });
    B = await seedTenant(env, { slug: 'client-b', users: [{ key: 'bob', displayName: 'Bob', role: 'salesperson', phone: '+919800000002' }] });
    db = env.get(DbService);
  });
  afterAll(async () => { await env.close(); });

  it('the runtime role is not a superuser, so RLS really applies', async () => {
    const [r] = await db.client`select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as su`;
    expect(r.u).toBe('crmbee_app');
    expect(r.su).toBe(false);
  });

  it('a tenant transaction only sees its own rows', async () => {
    const seenA = await db.tenantTx(A.tenantId, (tx) => tx.select().from(users));
    const seenB = await db.tenantTx(B.tenantId, (tx) => tx.select().from(users));
    expect(seenA.map((u) => u.tenantId)).toEqual([A.tenantId]);
    expect(seenB.map((u) => u.tenantId)).toEqual([B.tenantId]);
  });

  it('without a tenant context no tenant rows are visible', async () => {
    const rows = await db.db.select().from(users); // plain pool access: no app.tenant_id set
    expect(rows).toHaveLength(0);
  });

  it('guessing another tenant\'s draft id returns nothing', async () => {
    const drafts_ = env.get<DraftService>(DraftService);
    const d = await drafts_.create({ tenantId: A.tenantId, userId: A.users.sam.id, conversationId: 'c1', channel: 'whatsapp', kind: 'capture', data: emptyCapture('new') });
    expect(await drafts_.get(B.tenantId, d.id)).toBeNull();
    const direct = await db.tenantTx(B.tenantId, (tx) => tx.select().from(drafts).where(eq(drafts.id, d.id)));
    expect(direct).toHaveLength(0);
  });

  it('WITH CHECK blocks writing rows for another tenant', async () => {
    await expect(db.tenantTx(B.tenantId, (tx) => tx.insert(auditLog).values({ tenantId: A.tenantId, action: 'x' }))).rejects.toThrow();
  });

  it('tenant context does not leak across pooled connections (reset per transaction)', async () => {
    // Run many alternating transactions over a small pool and check each only ever sees its own tenant.
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => {
      const t = i % 2 ? A : B;
      return db.tenantTx(t.tenantId, async (tx) => ({ expected: t.tenantId, seen: (await tx.select({ t: users.tenantId }).from(users)).map((r) => r.t) }));
    }));
    for (const r of results) expect(new Set(r.seen)).toEqual(new Set([r.expected]));
    const [leak] = await db.client`select current_setting('app.tenant_id', true) as t`;
    expect(leak.t ?? '').toBe('');
  });

  it('a stale or foreign channel binding does not resolve to the other tenant', async () => {
    const identity = env.get<IdentityService>(IdentityService);
    const res = await identity.resolveInbound({ channel: 'whatsapp', connectionId: '1000000001', externalId: '+919800000002' });
    expect(res.kind).toBe('resolved');
    if (res.kind === 'resolved') expect(res.identity.tenant.tenantId).toBe(B.tenantId);
    expect((await identity.resolveInbound({ channel: 'whatsapp', connectionId: '1000000001', externalId: '+910000000000' })).kind).toBe('unknown');
  });

  it('audit log is append-only', async () => {
    await env.get<DbService>(DbService).tenantTx(A.tenantId, (tx) => tx.insert(auditLog).values({ tenantId: A.tenantId, action: 'test.append' }));
    const failure = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e: any) { return `${e.message} ${e.cause?.message ?? ''}`; } };
    expect(await failure(db.tenantTx(A.tenantId, (tx) => tx.execute(sql`update audit_log set action = 'tampered'`)))).toMatch(/append-only/);
    expect(await failure(db.tenantTx(A.tenantId, (tx) => tx.execute(sql`delete from audit_log`)))).toMatch(/append-only/);
  });
});
