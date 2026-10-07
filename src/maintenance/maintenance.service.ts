import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { DraftService } from '../conversation/draft.service';
import { MediaService } from '../media/media.service';
import { TenantService } from '../tenant/tenant.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

/** postgres-js cannot infer Date parameters in raw SQL under PgBouncer-safe (unprepared) mode: send ISO text. */
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/**
 * Automated retention and cleanup (SEC-04). Defaults: unconfirmed drafts expire after 30
 * minutes of inactivity; abandoned media after 24h; confirmed media after 30 days; raw email and
 * review items after 30 days; operational events after 30 days; audit after 12 months.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly db: DbService,
    private readonly drafts: DraftService,
    private readonly media: MediaService,
    private readonly tenants: TenantService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Runs every minute. */
  async frequent(now: Date = new Date()): Promise<{ draftsExpired: number }> {
    return { draftsExpired: await this.drafts.expireDue(now) };
  }

  /** Runs hourly. */
  async hourly(now: Date = new Date()): Promise<Record<string, number>> {
    const mediaDeleted = await this.media.cleanup(now, this.config.retention.mediaCleanupHours);
    const keys = await this.db.systemTx((tx) => tx.execute(sql`delete from idempotency_keys where expires_at < ${at(now)}`));
    const events = await this.db.systemTx((tx) => tx.execute(sql`delete from inbound_events where created_at < ${at(new Date(now.getTime() - 14 * 86_400_000))}`));
    const usage = await this.db.systemTx((tx) => tx.execute(sql`delete from usage_events where occurred_at < ${at(new Date(now.getTime() - 400 * 86_400_000))}`));
    const delivery = await this.db.systemTx((tx) => tx.execute(sql`delete from delivery_state where created_at < ${at(new Date(now.getTime() - this.config.retention.logRetentionDays * 86_400_000))} and status in ('sent','delivered','read','failed')`));
    return { mediaDeleted, idempotencyKeys: keys.count ?? 0, inboundEvents: events.count ?? 0, usage: usage.count ?? 0, delivery: delivery.count ?? 0 };
  }

  /** Runs daily. Per-tenant policy overrides the defaults. */
  async daily(now: Date = new Date()): Promise<Record<string, number>> {
    const out: Record<string, number> = { audit: 0, intakeReview: 0 };
    for (const tenantId of await this.tenants.listActiveIds()) {
      const t = await this.tenants.getContext(tenantId);
      const auditDays = t.retention.auditRetentionDays ?? this.config.retention.auditRetentionDays;
      const reviewDays = t.retention.reviewRetentionDays ?? 30;
      const a = await this.db.tenantTx(tenantId, async (tx) => {
        await tx.execute(sql`select set_config('app.audit_purge', 'on', true)`);
        return tx.execute(sql`delete from audit_log where tenant_id = ${tenantId} and timestamp < ${at(new Date(now.getTime() - auditDays * 86_400_000))}`);
      });
      out.audit += a.count ?? 0;
      const r = await this.db.tenantTx(tenantId, (tx) => tx.execute(sql`delete from intake_records where tenant_id = ${tenantId} and state in ('rejected','committed','failed') and updated_at < ${at(new Date(now.getTime() - reviewDays * 86_400_000))}`));
      out.intakeReview += r.count ?? 0;
    }
    return out;
  }
}
