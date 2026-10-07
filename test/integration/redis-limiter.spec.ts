import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisMemoryServer } from 'redis-memory-server';
import { RedisLimiterBackend } from '../../src/ratelimit/limiter';

/** Runs the real Lua scripts against a real redis-server (built by redis-memory-server). */
describe('Redis limiter backend (SYNC-04, TEN-04, TEN-05)', () => {
  let server: RedisMemoryServer; let url: string;
  beforeAll(async () => {
    server = new RedisMemoryServer();
    url = `redis://${await server.getHost()}:${await server.getPort()}`;
  }, 120000);
  afterAll(async () => { await server.stop(); });

  it('token bucket is shared across processes: two instances draw from one budget', async () => {
    const a = new RedisLimiterBackend(url, 'A'); const b = new RedisLimiterBackend(url, 'B');
    const key = `ws-${Date.now()}`;
    const results: boolean[] = [];
    for (let i = 0; i < 12; i++) results.push((i % 2 ? a : b) && (await (i % 2 ? a : b).consume(key, 1, 60, 10)).allowed);
    expect(results.filter(Boolean)).toHaveLength(10); // burst of 10 shared by both
    const denied = await a.consume(key, 1, 60, 10);
    expect(denied.allowed).toBe(false); expect(denied.retryAfterMs).toBeGreaterThan(0);
    await a.close(); await b.close();
  });

  it('refills over time', async () => {
    const a = new RedisLimiterBackend(url); const key = `refill-${Date.now()}`;
    for (let i = 0; i < 5; i++) await a.consume(key, 1, 600, 5); // 600/min = 10/s
    expect((await a.consume(key, 1, 600, 5)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 450));
    expect((await a.consume(key, 1, 600, 5)).allowed).toBe(true);
    await a.close();
  });

  it('concurrency leases are capped across processes, released explicitly, and expire if a holder dies', async () => {
    const a = new RedisLimiterBackend(url, 'A'); const b = new RedisLimiterBackend(url, 'B'); const key = `lease-${Date.now()}`;
    const l1 = await a.acquireLease(key, 2, 400); const l2 = await b.acquireLease(key, 2, 400);
    expect(l1 && l2).toBeTruthy();
    expect(await a.acquireLease(key, 2, 400)).toBeNull();
    await a.releaseLease(key, l1!);
    expect(await b.acquireLease(key, 2, 400)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500)); // holders "crash": leases lapse
    expect(await a.acquireLease(key, 2, 400)).toBeTruthy();
    await a.close(); await b.close();
  });

  it('parallel acquisition never exceeds the cap (atomic Lua)', async () => {
    const key = `race-${Date.now()}`; const backends = Array.from({ length: 5 }, (_, i) => new RedisLimiterBackend(url, `P${i}`));
    const got = await Promise.all(Array.from({ length: 40 }, (_, i) => backends[i % 5].acquireLease(key, 3, 5000)));
    expect(got.filter(Boolean)).toHaveLength(3);
    await Promise.all(backends.map((b) => b.close()));
  });

  it('when Redis is unreachable it fails CLOSED to a conservative local limit instead of allowing unbounded calls', async () => {
    const dead = new RedisLimiterBackend('redis://127.0.0.1:1');
    const key = 'down';
    const allowed = [];
    for (let i = 0; i < 40; i++) allowed.push((await dead.consume(key, 1, 80, 20)).allowed);
    expect(allowed.filter(Boolean).length).toBeLessThanOrEqual(5); // a quarter of the burst
    expect(await dead.ping()).toBe(false);
    const lease = await dead.acquireLease('w', 2, 1000);
    expect(lease).toBeTruthy(); expect(await dead.acquireLease('w', 2, 1000)).toBeNull(); // concurrency halved to 1
    await dead.close();
  });
});
