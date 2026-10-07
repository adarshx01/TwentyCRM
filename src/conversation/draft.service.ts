import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { DbService, type Tx } from '../database/db.service';
import { drafts, type DraftState, type MediaRef, type ProposedAction } from '../database/schema';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { AuditService } from '../audit/audit.service';
import { M } from '../observability/metrics';
import type { DraftData } from './draft.types';

export type DraftRow = typeof drafts.$inferSelect;

/** Canonical JSON (sorted keys) so the content hash is stable (ACT-02). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export const hashDraftContent = (actions: unknown, data: unknown): string => createHash('sha256').update(stableStringify({ actions, data })).digest('hex');

const ACTIVE: DraftState[] = ['collecting', 'awaiting_confirmation'];

export interface DraftChange {
  data?: DraftData;
  actions?: ProposedAction[];
  state?: DraftState;
  mediaRefs?: MediaRef[];
  addEventId?: string;
  previewMessageId?: string;
  /** Content edits invalidate older buttons and previews (ACT-02) */
  bumpVersion?: boolean;
}

/**
 * Draft lifecycle (ACT-01..ACT-05). Every mutation takes a row lock, so commits and edits
 * for one draft are serialized (ACT-03). Terminal states are also enforced by a DB trigger.
 *
 *   collecting → awaiting_confirmation → committing → committed
 *                                     ↘ cancelled | expired | needs_repair
 */
@Injectable()
export class DraftService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  expiryFrom(now: Date, seconds?: number): Date {
    return new Date(now.getTime() + (seconds ?? this.config.retention.draftExpirySeconds) * 1000);
  }

  async create(input: { tenantId: string; userId: string; conversationId: string; channel: string; kind: 'capture' | 'mutation'; data: DraftData; sourceEventId?: string; expirySeconds?: number; actions?: ProposedAction[]; state?: DraftState; mediaRefs?: MediaRef[] }): Promise<DraftRow> {
    const state = input.state ?? 'collecting';
    const [row] = await this.db.tenantTx(input.tenantId, async (tx) => {
      const rows = await tx.insert(drafts).values({
        tenantId: input.tenantId, userId: input.userId, conversationId: input.conversationId, channel: input.channel, kind: input.kind, state,
        proposedActions: input.actions ?? [], extractedData: input.data as any, sourceEventIds: input.sourceEventId ? [input.sourceEventId] : [], mediaRefs: input.mediaRefs ?? [],
        expiresAt: this.expiryFrom(new Date(), input.expirySeconds),
        contentHash: state === 'awaiting_confirmation' ? hashDraftContent(input.actions ?? [], input.data) : null,
      }).returning();
      await this.audit.writeTx(tx, { tenantId: input.tenantId, userId: input.userId, channel: input.channel, sourceEventId: input.sourceEventId, action: 'draft.created', resourceType: 'draft', resourceId: rows[0].id });
      return rows;
    });
    M.draftTransitions().inc({ from: 'none', to: state });
    return row;
  }

  async get(tenantId: string, id: string): Promise<DraftRow | null> {
    const [row] = await this.db.tenantTx(tenantId, (tx) => tx.select().from(drafts).where(eq(drafts.id, id)));
    return row ?? null;
  }

  /** Non-terminal drafts in one conversation for one user, newest first. */
  async listActive(tenantId: string, userId: string, conversationId: string, now: Date = new Date()): Promise<DraftRow[]> {
    const rows = await this.db.tenantTx(tenantId, (tx) =>
      tx.select().from(drafts).where(and(eq(drafts.userId, userId), eq(drafts.conversationId, conversationId), inArray(drafts.state, ACTIVE))).orderBy(desc(drafts.createdAt)),
    );
    return rows.filter((r) => !r.expiresAt || r.expiresAt > now);
  }

  /** Run `fn` with the draft row locked; the callback returns the change to persist (or null). */
  async mutate(tenantId: string, id: string, fn: (row: DraftRow, tx: Tx) => Promise<DraftChange | null> | DraftChange | null): Promise<{ row: DraftRow; changed: boolean } | null> {
    return this.db.tenantTx(tenantId, async (tx) => {
      const [row] = await tx.select().from(drafts).where(eq(drafts.id, id)).for('update');
      if (!row) return null;
      const change = await fn(row, tx);
      if (!change) return { row, changed: false };
      const state = change.state ?? row.state;
      const data = change.data ?? (row.extractedData as unknown as DraftData);
      const actions = change.actions ?? row.proposedActions;
      const version = change.bumpVersion ? row.version + 1 : row.version;
      const now = new Date();
      const [updated] = await tx.update(drafts).set({
        state, version, extractedData: data as any, proposedActions: actions,
        contentHash: state === 'awaiting_confirmation' ? hashDraftContent(actions, data) : state === 'collecting' ? null : row.contentHash,
        mediaRefs: change.mediaRefs ?? row.mediaRefs,
        sourceEventIds: change.addEventId && !row.sourceEventIds.includes(change.addEventId) ? [...row.sourceEventIds, change.addEventId] : row.sourceEventIds,
        previewMessageId: change.previewMessageId ?? row.previewMessageId,
        // Expiry is measured from the latest edit (ACT-02).
        expiresAt: ACTIVE.includes(state) ? this.expiryFrom(now) : row.expiresAt,
        updatedAt: now,
      }).where(eq(drafts.id, id)).returning();
      if (state !== row.state) M.draftTransitions().inc({ from: row.state, to: state });
      return { row: updated, changed: true };
    });
  }

  async cancel(tenantId: string, id: string, userId: string): Promise<'cancelled' | 'not_active' | 'not_found'> {
    const res = await this.mutate(tenantId, id, (row) => {
      if (row.userId !== userId) return null;
      if (!ACTIVE.includes(row.state)) return null;
      return { state: 'cancelled' };
    });
    if (!res) return 'not_found';
    if (res.row.userId !== userId) return 'not_found';
    if (res.changed) await this.audit.write({ tenantId, userId, channel: res.row.channel, action: 'draft.cancelled', resourceType: 'draft', resourceId: id });
    return res.changed ? 'cancelled' : 'not_active';
  }

  /** Expire drafts 30 minutes after the latest edit; they create no CRM records (SEC-04, AT-04). */
  async expireDue(now: Date = new Date()): Promise<number> {
    const rows = await this.db.systemTx((tx) =>
      tx.update(drafts).set({ state: 'expired', updatedAt: now }).where(and(inArray(drafts.state, ACTIVE), lt(drafts.expiresAt, now))).returning({ id: drafts.id, tenantId: drafts.tenantId, userId: drafts.userId }),
    );
    if (rows.length) M.draftTransitions().inc({ from: 'active', to: 'expired' }, rows.length);
    return rows.length;
  }
}
