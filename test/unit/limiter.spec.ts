import { describe, expect, it } from 'vitest';
import { MemoryLimiterBackend } from '../../src/ratelimit/limiter';
import { WorkspaceLimiter } from '../../src/ratelimit/workspace-limiter';
import { QuotaService } from '../../src/tenant/quota.service';
import { RetryLaterError } from '../../src/common/errors';
import { deterministicUuid } from '../../src/queue/queue.service';

describe('token bucket and leases (SYNC-04, TEN-05)', () => {
  it('allows a burst then throttles, then refills over time', async () => {
    let now = 0;
    const b = new MemoryLimiterBackend(() => now);
    const got = [];
    for (let i = 0; i < 12; i++) got.push((await b.consume('k', 1, 60, 10)).allowed);
    expect(got.filter(Boolean)).toHaveLength(10);
    const denied = await b.consume('k', 1, 60, 10);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    now += 5_000; // 60/min → 5 tokens
    expect((await b.consume('k', 5, 60, 10)).allowed).toBe(true);
    expect((await b.consume('k', 1, 60, 10)).allowed).toBe(false);
  });
  it('buckets are independent per key (workspace A cannot starve B)', async () => {
    const b = new MemoryLimiterBackend(() => 0);
    for (let i = 0; i < 20; i++) await b.consume('twenty:A', 1, 60, 5);
    expect((await b.consume('twenty:B', 1, 60, 5)).allowed).toBe(true);
  });
  it('leases cap concurrency and expire if a holder dies', async () => {
    let now = 0;
    const b = new MemoryLimiterBackend(() => now);
    const l1 = await b.acquireLease('w', 2, 1000); const l2 = await b.acquireLease('w', 2, 1000);
    expect(l1 && l2).toBeTruthy();
    expect(await b.acquireLease('w', 2, 1000)).toBeNull();
    await b.releaseLease('w', l1!);
    expect(await b.acquireLease('w', 2, 1000)).toBeTruthy();
    now += 1500; // crashed holders' leases expire
    expect(await b.acquireLease('w', 2, 1000)).toBeTruthy();
  });
  it('a workspace that exceeds its budget is deferred with RetryLater, not failed', async () => {
    const cfg: any = { twenty: { rateLimit: 4, maxConcurrentWrites: 2 } };
    const lim = new WorkspaceLimiter(cfg, new MemoryLimiterBackend());
    for (let i = 0; i < 1; i++) await lim.takeRequest('ws', 1, 0);
    let err: unknown;
    for (let i = 0; i < 5; i++) { try { await lim.takeRequest('ws', 1, 0); } catch (e) { err = e; } }
    expect(err).toBeInstanceOf(RetryLaterError);
  });
  it('max in-flight writes per workspace is enforced', async () => {
    const lim = new WorkspaceLimiter({ twenty: { rateLimit: 1000, maxConcurrentWrites: 2 } } as any, new MemoryLimiterBackend());
    const a = await lim.acquireWriteLease('ws'); await lim.acquireWriteLease('ws');
    await expect(lim.acquireWriteLease('ws')).rejects.toBeInstanceOf(RetryLaterError);
    await a.release();
    await expect(lim.acquireWriteLease('ws')).resolves.toBeTruthy();
  });
  it('per-tenant AI slots keep one client from taking every worker', async () => {
    const q = new QuotaService(new MemoryLimiterBackend());
    const t: any = { tenantId: 't1', quotaLimits: { maxAiJobsInFlight: 2 } };
    await q.acquireAiSlot(t); await q.acquireAiSlot(t);
    await expect(q.acquireAiSlot(t)).rejects.toBeInstanceOf(RetryLaterError);
    await expect(q.acquireAiSlot({ tenantId: 't2', quotaLimits: {} } as any)).resolves.toBeTruthy();
  });
  it('upload quota rejects a flood with a friendly message', async () => {
    const q = new QuotaService(new MemoryLimiterBackend());
    const t: any = { tenantId: 't1', quotaLimits: { maxUploadsPerMinute: 3 } };
    for (let i = 0; i < 3; i++) await q.checkUpload(t);
    await expect(q.checkUpload(t)).rejects.toThrow(/Too many uploads/);
  });
  it('queue job ids are deterministic per idempotency key', () => {
    expect(deterministicUuid('crm-write:op1')).toBe(deterministicUuid('crm-write:op1'));
    expect(deterministicUuid('crm-write:op1')).not.toBe(deterministicUuid('crm-write:op2'));
    expect(deterministicUuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
