import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../database/db.service';
import { inboundEvents } from '../database/schema';
import { QueueService } from '../queue/queue.service';
import { QUEUES, type InboundEventJob } from '../queue/queues';
import { NormalizedEventSchema, type NormalizedEvent } from '../common/schemas';
import { M } from '../observability/metrics';
import { currentCorrelationId } from '../common/context/request-context';

/**
 * Durable acceptance (Section 9, ACT-05). The webhook handler only verifies, de-duplicates,
 * persists and enqueues — in one transaction — then acknowledges. Provider retries and
 * replays hit the unique (channel, provider_event_id) key and are suppressed.
 */
@Injectable()
export class InboundService {
  constructor(private readonly db: DbService, private readonly queue: QueueService) {}

  async accept(raw: NormalizedEvent): Promise<'accepted' | 'duplicate'> {
    const event = NormalizedEventSchema.parse(raw);
    const correlationId = currentCorrelationId();
    const inserted = await this.db.systemTx(async (tx) => {
      const rows = await tx.insert(inboundEvents).values({ providerEventId: event.providerEventId, channel: event.channel, eventType: event.messageType, payload: event as any, correlationId })
        .onConflictDoNothing({ target: [inboundEvents.channel, inboundEvents.providerEventId] }).returning({ id: inboundEvents.id });
      if (!rows.length) return null;
      await this.queue.sendInTx(tx, QUEUES.INBOUND, { eventId: rows[0].id } satisfies InboundEventJob, { correlationId, idempotencyKey: `in:${event.channel}:${event.providerEventId}` });
      return rows[0].id;
    });
    if (!inserted) { M.duplicateSuppressed().inc({ kind: 'webhook', channel: event.channel }); return 'duplicate'; }
    return 'accepted';
  }

  async load(eventId: string): Promise<{ event: NormalizedEvent; processed: boolean } | null> {
    const [row] = await this.db.systemTx((tx) => tx.select().from(inboundEvents).where(eq(inboundEvents.id, eventId)));
    if (!row?.payload) return null;
    return { event: NormalizedEventSchema.parse(row.payload), processed: !!row.processedAt };
  }

  async markProcessed(eventId: string, tenantId?: string, userId?: string): Promise<void> {
    await this.db.systemTx((tx) => tx.update(inboundEvents).set({ processedAt: new Date(), tenantId: tenantId ?? null, userId: userId ?? null, payload: null }).where(eq(inboundEvents.id, eventId)));
  }
}
