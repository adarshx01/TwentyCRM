import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DbService } from '../database/db.service';
import { schedules, users } from '../database/schema';
import { IdentityService } from '../identity/identity.service';
import { TenantService } from '../tenant/tenant.service';
import { calculateNextRunUtc, isWorkingDay } from '../common/utils/date.util';
import { getLogger } from '../observability/logger';

export const digestKey = (tenantId: string, userId: string, localDate: string, type = 'morning') => `${tenantId}/${userId}/${localDate}/${type}`;

/**
 * Creates the schedule rows that drive morning digests (REM-01, REM-03, REM-05).
 * One row per tenant/user/local-date/digest-type (unique key = idempotency, REM-06).
 * UTC execution time is computed from the user's IANA zone with Luxon, so DST
 * transitions never shift the local wall-clock time.
 */
@Injectable()
export class SchedulePlanner {
  private readonly log = getLogger('schedule-planner');

  constructor(
    private readonly db: DbService,
    private readonly identity: IdentityService,
    private readonly tenants: TenantService,
  ) {}

  /** Ensure the digest for one user/day exists (called when a task is created or edited). */
  async ensureDigest(tenantId: string, userId: string, localDate: string, now: Date = new Date()): Promise<boolean> {
    const live = await this.identity.getActiveUser(tenantId, userId);
    if (!live) return false;
    return this.insertIfEligible(tenantId, live.user.userId, live.user.timezone, live.user.morningReminderTime ?? live.tenant.morningReminderTime, live.tenant.workingDays, live.tenant.settings.reminderCutoffMinutes ?? 120, localDate, now);
  }

  private async insertIfEligible(tenantId: string, userId: string, tz: string, time: string, workingDays: number[], cutoffMin: number, localDate: string, now: Date): Promise<boolean> {
    if (!isWorkingDay(localDate, workingDays, tz)) return false;
    const nextRunUtc = new Date(calculateNextRunUtc(localDate, time, tz));
    // A digest whose cutoff already passed would be obsolete (REM-07): do not create it.
    if (nextRunUtc.getTime() + cutoffMin * 60_000 < now.getTime()) return false;
    const rows = await this.db.tenantTx(tenantId, (tx) =>
      tx.insert(schedules).values({ tenantId, userId, type: 'digest', localDate, nextRunUtc, timezone: tz, digestType: 'morning', idempotencyKey: digestKey(tenantId, userId, localDate) })
        .onConflictDoNothing({ target: schedules.idempotencyKey }).returning({ id: schedules.id }),
    );
    return rows.length > 0;
  }

  /**
   * Plan today and the next day for every active salesperson (REM-01).
   * Runs hourly; idempotent. Returns number of new schedule rows.
   */
  async planAll(now: Date = new Date(), horizonDays = 2): Promise<number> {
    let created = 0;
    for (const tenantId of await this.tenants.listActiveIds()) {
      try {
        const tenant = await this.tenants.getContext(tenantId);
        const people = await this.db.tenantTx(tenantId, (tx) =>
          tx.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.status, 'active'), isNull(users.revokedAt), eq(users.role, 'salesperson'))),
        );
        for (const u of people) {
          const tz = u.timezone ?? tenant.timezone;
          const today = DateTime.fromJSDate(now, { zone: tz }).startOf('day');
          for (let d = 0; d < horizonDays; d++) {
            const date = today.plus({ days: d }).toISODate()!;
            if (await this.insertIfEligible(tenantId, u.id, tz, u.morningReminderTime ?? tenant.morningReminderTime, tenant.workingDays, tenant.settings.reminderCutoffMinutes ?? 120, date, now)) created++;
          }
        }
      } catch (e) {
        this.log.error({ tenantId, err: (e as Error).message }, 'planning failed for tenant');
      }
    }
    return created;
  }
}
