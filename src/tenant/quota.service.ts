import { Inject, Injectable } from '@nestjs/common';
import { LIMITER_BACKEND, type LimiterBackend } from '../ratelimit/limiter';
import { RetryLaterError, UserFacingError } from '../common/errors';
import type { TenantContext } from '../common/types';
import { jitter } from '../ratelimit/workspace-limiter';

const DEFAULTS = { uploadsPerMinute: 30, messagesPerMinute: 120, remindersPerMinute: 120, aiJobsInFlight: 6 };

/**
 * Per-tenant quotas and fair scheduling (TEN-05): one client's uploads, AI jobs or
 * reminders cannot take all capacity. Limits are overridable per tenant.
 */
@Injectable()
export class QuotaService {
  constructor(@Inject(LIMITER_BACKEND) private readonly backend: LimiterBackend) {}

  /** Inbound uploads: reject with a friendly message instead of queueing unbounded work. */
  async checkUpload(tenant: TenantContext): Promise<void> {
    const rate = tenant.quotaLimits.maxUploadsPerMinute ?? DEFAULTS.uploadsPerMinute;
    const d = await this.backend.consume(`quota:upload:${tenant.tenantId}`, 1, rate, rate);
    if (!d.allowed) throw new UserFacingError('Too many uploads right now. Please try again in a minute.', 'QUOTA_UPLOADS');
  }

  async checkMessage(tenant: TenantContext): Promise<boolean> {
    const rate = tenant.quotaLimits.maxMessagesPerMinute ?? DEFAULTS.messagesPerMinute;
    return (await this.backend.consume(`quota:msg:${tenant.tenantId}`, 1, rate, rate)).allowed;
  }

  /** Reminder dispatch pacing: throws RetryLater when the tenant exceeds its share. */
  async takeReminderSlot(tenant: TenantContext): Promise<void> {
    const rate = tenant.quotaLimits.maxRemindersPerMinute ?? DEFAULTS.remindersPerMinute;
    const d = await this.backend.consume(`quota:reminder:${tenant.tenantId}`, 1, rate, Math.max(10, Math.floor(rate / 2)));
    if (!d.allowed) throw new RetryLaterError(d.retryAfterMs + jitter(1000), 'tenant_reminder_quota');
  }

  /** Bounded AI concurrency per tenant so one client cannot occupy every worker slot. */
  async acquireAiSlot(tenant: TenantContext): Promise<{ release(): Promise<void> }> {
    const max = tenant.quotaLimits.maxAiJobsInFlight ?? DEFAULTS.aiJobsInFlight;
    const key = `quota:ai:${tenant.tenantId}`;
    const token = await this.backend.acquireLease(key, max, 120_000);
    if (!token) throw new RetryLaterError(1500 + jitter(2000), 'tenant_ai_concurrency');
    return { release: () => this.backend.releaseLease(key, token) };
  }
}
