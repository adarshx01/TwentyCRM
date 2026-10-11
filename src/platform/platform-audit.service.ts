import { Injectable } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { platformAuditLog } from '../database/schema';
import { operatorActor, type OperatorPrincipal } from '../access/operator.service';

/** Append-only record of what platform operators did, kept apart from every tenant's audit trail. */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly db: DbService) {}

  async write(operator: OperatorPrincipal, action: string, opts: { tenantId?: string | null; target?: string; result?: 'success' | 'failure' | 'denied'; metadata?: Record<string, unknown> } = {}): Promise<void> {
    await this.db.systemTx((tx) =>
      tx.insert(platformAuditLog).values({ operatorId: operatorActor(operator), operatorName: operator.name, action, tenantId: opts.tenantId ?? null, target: opts.target, result: opts.result ?? 'success', metadata: (opts.metadata ?? null) as any }),
    );
  }

  async recent(limit = 100) {
    const rows = await this.db.systemTx((tx) => tx.select().from(platformAuditLog).orderBy(desc(platformAuditLog.id)).limit(Math.min(Math.max(limit, 1), 500)));
    return rows.map((r) => ({ id: r.id, at: r.at, operator: r.operatorName, operatorId: r.operatorId, action: r.action, tenantId: r.tenantId, target: r.target, result: r.result, metadata: r.metadata }));
  }
}
