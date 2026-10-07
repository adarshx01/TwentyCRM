import { Injectable } from '@nestjs/common';
import { DbService, type Tx } from '../database/db.service';
import { auditLog } from '../database/schema';
import { currentContext } from '../common/context/request-context';

export interface AuditEntry {
  tenantId: string;
  userId?: string | null;
  channel?: string;
  sourceEventId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  changedFields?: Record<string, unknown> | string[];
  confirmationId?: string;
  result?: 'success' | 'failure' | 'denied' | 'partial';
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEYS = /(token|secret|password|authorization|api[-_]?key|transcript|rawemail|body|html)/i;

/** Keep audit payloads useful but never store secrets or raw content (SEC-03). */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => maskSensitive(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEYS.test(k) ? '[masked]' : maskSensitive(v, depth + 1)]),
    );
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/** Append-only audit trail (SEC-03). Rows cannot be updated or deleted by the app role's normal paths. */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async write(entry: AuditEntry): Promise<void> {
    await this.db.tenantTx(entry.tenantId, (tx) => this.writeTx(tx, entry));
  }

  async writeTx(tx: Tx, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLog).values({
      tenantId: entry.tenantId,
      userId: entry.userId ?? null,
      channel: entry.channel,
      sourceEventId: entry.sourceEventId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      changedFields: maskSensitive(entry.changedFields) as any,
      confirmationId: entry.confirmationId,
      result: entry.result ?? 'success',
      correlationId: currentContext()?.correlationId,
      metadata: maskSensitive(entry.metadata) as any,
    });
  }
}
