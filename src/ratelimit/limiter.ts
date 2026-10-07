import Redis from 'ioredis';
import { getLogger } from '../observability/logger';

export interface RateDecision {
  allowed: boolean;
  /** Milliseconds until the requested cost would be available */
  retryAfterMs: number;
}

/**
 * Shared limiter backend. Redis holds only counters and leases — no business
 * state — so losing it loses nothing durable (Section 2).
 */
export interface LimiterBackend {
  /** Token bucket: refills `ratePerMin` per minute, capacity `burst`. */
  consume(key: string, cost: number, ratePerMin: number, burst: number): Promise<RateDecision>;
  /** Concurrency lease; returns a lease token or null when `max` leases are held. */
  acquireLease(key: string, max: number, ttlMs: number): Promise<string | null>;
  releaseLease(key: string, token: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
export const LIMITER_BACKEND = 'LIMITER_BACKEND';

export class MemoryLimiterBackend implements LimiterBackend {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private leases = new Map<string, Map<string, number>>();
  private seq = 0;
  constructor(private readonly now: () => number = Date.now) {}

  async consume(key: string, cost: number, ratePerMin: number, burst: number): Promise<RateDecision> {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: burst, at: t };
    const refill = ((t - b.at) / 60_000) * ratePerMin;
    b.tokens = Math.min(burst, b.tokens + refill);
    b.at = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.buckets.set(key, b);
      return { allowed: true, retryAfterMs: 0 };
    }
    this.buckets.set(key, b);
    const missing = cost - b.tokens;
    return { allowed: false, retryAfterMs: Math.ceil((missing / ratePerMin) * 60_000) };
  }

  async acquireLease(key: string, max: number, ttlMs: number): Promise<string | null> {
    const t = this.now();
    const set = this.leases.get(key) ?? new Map<string, number>();
    for (const [tok, exp] of set) if (exp <= t) set.delete(tok);
    if (set.size >= max) {
      this.leases.set(key, set);
      return null;
    }
    const token = `l${++this.seq}`;
    set.set(token, t + ttlMs);
    this.leases.set(key, set);
    return token;
  }

  async releaseLease(key: string, token: string): Promise<void> {
    this.leases.get(key)?.delete(token);
  }
  async ping(): Promise<boolean> { return true; }
  async close(): Promise<void> { /* nothing */ }
}

const CONSUME_LUA = `
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local data = redis.call('HMGET', key, 'tokens', 'at')
local tokens = tonumber(data[1])
local at = tonumber(data[2])
if tokens == nil then tokens = burst; at = now end
tokens = math.min(burst, tokens + ((now - at) / 60000) * rate)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil(((cost - tokens) / rate) * 60000)
end
redis.call('HMSET', key, 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', key, 120000)
return {allowed, retry}
`;

const ACQUIRE_LUA = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local token = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) >= max then return 0 end
redis.call('ZADD', key, now + ttl, token)
redis.call('PEXPIRE', key, ttl * 2)
return 1
`;

/**
 * Redis backend. If Redis is unreachable it fails CLOSED to a conservative local
 * limiter (a quarter of the configured rate, halved concurrency) instead of
 * allowing unbounded calls to Twenty (SYNC-04).
 */
export class RedisLimiterBackend implements LimiterBackend {
  private readonly redis: Redis;
  private readonly fallback = new MemoryLimiterBackend();
  private readonly log = getLogger('limiter');
  private seq = 0;
  /** Circuit breaker: after a Redis failure use the local fallback for a short while instead of waiting on every call. */
  private downUntil = 0;

  constructor(url: string, private readonly instance = process.env.HOSTNAME ?? 'proc') {
    // Offline queue on so the first commands wait for the connection; a short command timeout + breaker bound the delay when Redis is down.
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: true, commandTimeout: 1000, connectTimeout: 1500, retryStrategy: (n) => Math.min(n * 200, 2000) });
    this.redis.on('error', (e) => this.log.warn({ err: e.message }, 'redis error'));
  }

  async consume(key: string, cost: number, ratePerMin: number, burst: number): Promise<RateDecision> {
    if (Date.now() < this.downUntil) return this.fallback.consume(key, cost, Math.max(1, Math.floor(ratePerMin / 4)), Math.max(1, Math.floor(burst / 4)));
    try {
      const [allowed, retry] = (await this.redis.eval(CONSUME_LUA, 1, `crmbee:rl:${key}`, cost, ratePerMin, burst, Date.now())) as [number, number];
      return { allowed: allowed === 1, retryAfterMs: retry };
    } catch (e) {
      this.downUntil = Date.now() + 2000;
      this.log.warn({ err: (e as Error).message }, 'redis unavailable; using conservative local limit');
      return this.fallback.consume(key, cost, Math.max(1, Math.floor(ratePerMin / 4)), Math.max(1, Math.floor(burst / 4)));
    }
  }

  async acquireLease(key: string, max: number, ttlMs: number): Promise<string | null> {
    const token = `${this.instance}:${process.pid}:${Date.now()}:${++this.seq}`;
    if (Date.now() < this.downUntil) return this.fallback.acquireLease(key, Math.max(1, Math.floor(max / 2)), ttlMs);
    try {
      const ok = (await this.redis.eval(ACQUIRE_LUA, 1, `crmbee:lease:${key}`, max, ttlMs, Date.now(), token)) as number;
      return ok === 1 ? token : null;
    } catch {
      this.downUntil = Date.now() + 2000;
      return this.fallback.acquireLease(key, Math.max(1, Math.floor(max / 2)), ttlMs);
    }
  }

  async releaseLease(key: string, token: string): Promise<void> {
    try {
      await this.redis.zrem(`crmbee:lease:${key}`, token);
    } catch {
      await this.fallback.releaseLease(key, token);
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
