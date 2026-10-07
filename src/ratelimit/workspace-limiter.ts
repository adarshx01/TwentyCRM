import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { LIMITER_BACKEND, type LimiterBackend } from './limiter';
import { M } from '../observability/metrics';
import { RetryLaterError } from '../common/errors';

export interface WorkspaceLease {
  release(): Promise<void>;
}

/**
 * Protects each Twenty workspace (SYNC-04, TEN-04, TEN-05):
 *  - request budget per minute (token bucket, default 80% of Twenty's published 100/min)
 *  - at most N concurrent write operations per workspace
 * A job that cannot get budget is re-delayed with jitter; that is not a failure.
 */
@Injectable()
export class WorkspaceLimiter {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LIMITER_BACKEND) private readonly backend: LimiterBackend,
  ) {}

  /** Wait (bounded) for request budget; throws RetryLaterError when the wait is long. */
  async takeRequest(workspaceId: string, cost = 1, maxWaitMs = 3000): Promise<void> {
    const rate = this.config.twenty.rateLimit;
    const burst = Math.max(1, Math.ceil(rate / 4));
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const d = await this.backend.consume(`twenty:${workspaceId}`, cost, rate, burst);
      if (d.allowed) return;
      M.twentyRateDelays().inc({ workspace: workspaceId });
      const wait = d.retryAfterMs + Math.floor(Math.random() * 100);
      if (Date.now() + wait > deadline) throw new RetryLaterError(wait + jitter(500), 'twenty_rate_budget');
      await sleep(wait);
    }
  }

  async acquireWriteLease(workspaceId: string, ttlMs = 60_000): Promise<WorkspaceLease> {
    const key = `writes:${workspaceId}`;
    const token = await this.backend.acquireLease(key, this.config.twenty.maxConcurrentWrites, ttlMs);
    if (!token) throw new RetryLaterError(500 + jitter(1500), 'twenty_write_concurrency');
    return { release: () => this.backend.releaseLease(key, token) };
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const jitter = (max: number) => Math.floor(Math.random() * max);
