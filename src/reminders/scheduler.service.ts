import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { QueueService } from '../queue/queue.service';
import { QUEUES, type ReminderJob } from '../queue/queues';
import { getLogger } from '../observability/logger';

/**
 * Claims due schedule rows with FOR UPDATE SKIP LOCKED (REM-01, AT-09). Safe to run on
 * several replicas and safe to run twice: a row is claimed once, the reminder job id is
 * derived from the row's idempotency key, and DigestService is idempotent.
 */
@Injectable()
export class SchedulerService {
  private readonly log = getLogger('scheduler');

  constructor(private readonly db: DbService, private readonly queue: QueueService) {}

  async tick(workerId: string, batch = 50, maxBatches = 40): Promise<number> {
    await this.reclaimStale();
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const claimed = await this.db.systemTx(async (tx) => {
        const rows = await tx.execute<{ id: string; tenant_id: string; user_id: string; idempotency_key: string }>(sql`
          update schedules set state = 'claimed', claimed_at = now(), claimed_by = ${workerId}
           where id in (select id from schedules where state = 'pending' and next_run_utc <= now()
                         order by next_run_utc asc limit ${batch} for update skip locked)
          returning id, tenant_id, user_id, idempotency_key`);
        // Enqueue in the same transaction so a claimed row always has a job.
        for (const r of rows) {
          await this.queue.sendInTx(tx, QUEUES.REMINDER, { scheduleId: r.id } satisfies ReminderJob, { tenantId: r.tenant_id, userId: r.user_id, idempotencyKey: `rem:${r.idempotency_key}` });
        }
        return rows.length;
      });
      total += claimed;
      if (claimed < batch) break;
    }
    if (total) this.log.info({ claimed: total }, 'schedules claimed');
    return total;
  }

  /** A worker that died after claiming leaves the row `claimed`; hand it back (job id dedup keeps this safe). */
  private async reclaimStale(): Promise<void> {
    await this.db.systemTx((tx) =>
      tx.execute(sql`update schedules set state = 'pending', claimed_at = null, claimed_by = null, retry_count = retry_count + 1
                      where state = 'claimed' and claimed_at < now() - interval '10 minutes' and retry_count < 5`),
    );
  }
}
