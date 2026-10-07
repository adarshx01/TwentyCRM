import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { intakeSources } from '../database/schema';
import { IdentityService } from '../identity/identity.service';

/**
 * Owner selection for intake (IN-10). A designated salesperson wins; otherwise round-robin.
 * The cursor advances inside a row-locked transaction, so concurrent emails get distinct
 * turns (atomic); callers persist the chosen owner so a replay never advances it twice (idempotent).
 */
@Injectable()
export class AssignmentService {
  constructor(private readonly db: DbService, private readonly identity: IdentityService) {}

  async pick(tenantId: string, sourceUuid: string): Promise<string | null> {
    return this.db.tenantTx(tenantId, async (tx) => {
      const [src] = await tx.select().from(intakeSources).where(eq(intakeSources.id, sourceUuid)).for('update');
      if (!src) return null;
      const r = src.crmRouting;
      if (r.ownerUserId && (await this.identity.getActiveUser(tenantId, r.ownerUserId))) return r.ownerUserId;
      const pool = r.roundRobinUserIds ?? [];
      if (!pool.length) return null;
      const start = ((r.roundRobinCursor ?? -1) + 1) % pool.length;
      for (let i = 0; i < pool.length; i++) {
        const idx = (start + i) % pool.length;
        const live = await this.identity.getActiveUser(tenantId, pool[idx]);
        if (live && live.user.role === 'salesperson') {
          await tx.update(intakeSources).set({ crmRouting: { ...r, roundRobinCursor: idx }, updatedAt: new Date() }).where(eq(intakeSources.id, sourceUuid));
          return pool[idx];
        }
      }
      return null;
    });
  }
}
