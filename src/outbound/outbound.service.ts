import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { DbService, type Tx } from '../database/db.service';
import { channelBindings, deliveryState } from '../database/schema';
import { QueueService } from '../queue/queue.service';
import { QUEUES, type OutboundJob } from '../queue/queues';
import { IdentityService } from '../identity/identity.service';
import { CHANNEL_SENDERS, WHATSAPP_WINDOW_MS, type ChannelSenders, type OutboundContent, type SendTarget } from '../channels/channel.types';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { RetryLaterError } from '../common/errors';
import { M } from '../observability/metrics';
import { getLogger } from '../observability/logger';
import type { ChannelName } from '../common/types';

export interface EnqueueMessage {
  tenantId: string;
  userId: string;
  channel: ChannelName;
  messageType: 'chat_reply' | 'digest' | 'notification' | 'preview';
  content: OutboundContent;
  /** Detail to deliver after the employee replies to a template (WA-03) */
  deferred?: OutboundContent;
  idempotencyKey: string;
}

/**
 * Outbound delivery (WA-01..03, AT-09, AT-10, IAM-05).
 *
 *  - Only employees with an active, enrolled binding can ever be a recipient. Contact
 *    phone numbers from cards or forms are never looked up here (WA-01, SEC-05).
 *  - Each send is keyed (unique idempotency key) so replays and restarts do not duplicate it.
 *  - If a request may have reached the provider but no answer arrived, the row becomes
 *    `ambiguous` and is NOT blindly re-sent; operators reconcile it.
 */
@Injectable()
export class OutboundService {
  private readonly log = getLogger('outbound');

  constructor(
    private readonly db: DbService,
    private readonly queue: QueueService,
    private readonly identity: IdentityService,
    @Inject(CHANNEL_SENDERS) private readonly senders: ChannelSenders,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Persist the delivery row and enqueue the send atomically. Returns the row id. */
  async enqueue(msg: EnqueueMessage, tx?: Tx): Promise<string> {
    const run = async (t: Tx): Promise<string> => {
      const [row] = await t
        .insert(deliveryState)
        .values({
          tenantId: msg.tenantId, userId: msg.userId, channel: msg.channel, messageType: msg.messageType, idempotencyKey: msg.idempotencyKey,
          payload: msg.content as any, deferredPayload: (msg.deferred as any) ?? null,
        })
        .onConflictDoNothing({ target: deliveryState.idempotencyKey })
        .returning({ id: deliveryState.id });
      if (!row) {
        M.duplicateSuppressed().inc({ kind: 'outbound' });
        const [existing] = await t.select({ id: deliveryState.id }).from(deliveryState).where(eq(deliveryState.idempotencyKey, msg.idempotencyKey));
        return existing.id;
      }
      await this.queue.sendInTx(t, QUEUES.OUTBOUND, { deliveryId: row.id } satisfies OutboundJob, { tenantId: msg.tenantId, userId: msg.userId, idempotencyKey: `out:${msg.idempotencyKey}` });
      return row.id;
    };
    return tx ? run(tx) : this.db.tenantTx(msg.tenantId, run);
  }

  /** Worker entry point. Throws RetryLaterError / Error to let the queue retry. */
  async deliver(tenantId: string, deliveryId: string): Promise<void> {
    const row = await this.db.tenantTx(tenantId, async (tx) => {
      const [r] = await tx.select().from(deliveryState).where(eq(deliveryState.id, deliveryId));
      return r;
    });
    if (!row) return;
    if (['sent', 'delivered', 'read', 'failed', 'ambiguous', 'deferred'].includes(row.status)) return;

    const fail = async (code: string, message: string, status: 'failed' = 'failed') => {
      await this.db.tenantTx(tenantId, (tx) => tx.update(deliveryState).set({ status, failedAt: new Date(), errorInfo: { code, message } }).where(eq(deliveryState.id, deliveryId)));
      M.outboundResults().inc({ channel: row.channel, result: code });
    };

    // A previous attempt crashed or timed out after marking `sending`: do not resend blindly.
    if (row.status === 'sending') {
      await this.db.tenantTx(tenantId, (tx) => tx.update(deliveryState).set({ status: 'ambiguous', errorInfo: { code: 'AMBIGUOUS_SEND', message: 'previous attempt outcome unknown' } }).where(eq(deliveryState.id, deliveryId)));
      M.outboundResults().inc({ channel: row.channel, result: 'ambiguous' });
      this.log.warn({ deliveryId }, 'ambiguous send held for reconciliation');
      return;
    }

    // Recipient eligibility is re-read at send time (IAM-05).
    if (!row.userId || !(await this.identity.getActiveUser(tenantId, row.userId))) return fail('recipient_ineligible', 'recipient is not an active employee');

    const [binding] = await this.db.tenantTx(tenantId, (tx) =>
      tx.select().from(channelBindings).where(and(eq(channelBindings.userId, row.userId!), eq(channelBindings.channel, row.channel), eq(channelBindings.status, 'active'))).orderBy(desc(channelBindings.lastInboundAt)).limit(1),
    );
    if (!binding) return fail('no_binding', 'no active channel binding for the recipient');
    if (binding.optedOut) return fail('opted_out', 'recipient opted out');

    const sender = this.senders[row.channel as ChannelName];
    if (!sender) return fail('channel_unavailable', 'channel is not configured');

    let content = row.payload as unknown as OutboundContent;
    // Outside WhatsApp's 24h window only an approved template may be sent (AT-10).
    if (row.channel === 'whatsapp' && content.kind !== 'template') {
      const open = binding.lastInboundAt && Date.now() - binding.lastInboundAt.getTime() < WHATSAPP_WINDOW_MS;
      if (!open) {
        const wa = this.config.whatsapp;
        if (!wa) return fail('channel_unavailable', 'whatsapp not configured');
        const tpl: OutboundContent = { kind: 'template', name: wa.templateName, params: [], fallbackText: content.text };
        await this.db.tenantTx(tenantId, (tx) => tx.update(deliveryState).set({ payload: tpl as any, deferredPayload: row.deferredPayload ?? (content as any) }).where(eq(deliveryState.id, deliveryId)));
        content = tpl;
      }
    }

    // Claim the send exactly once.
    const claimed = await this.db.tenantTx(tenantId, (tx) =>
      tx.update(deliveryState).set({ status: 'sending', sendingAt: new Date() }).where(and(eq(deliveryState.id, deliveryId), eq(deliveryState.status, 'pending'))).returning({ id: deliveryState.id }),
    );
    if (!claimed.length) return;

    const target: SendTarget = { tenantId, userId: row.userId, channel: row.channel as ChannelName, externalId: binding.externalId, connectionId: binding.connectionId, conversationRef: binding.conversationRef };
    const result = await sender.send(target, content, row.idempotencyKey);

    switch (result.kind) {
      case 'sent':
        await this.db.tenantTx(tenantId, (tx) => tx.update(deliveryState).set({ status: 'sent', externalMessageId: result.externalId, sentAt: new Date() }).where(eq(deliveryState.id, deliveryId)));
        M.outboundResults().inc({ channel: row.channel, result: 'sent' });
        return;
      case 'rejected':
        return fail(result.code, result.message);
      case 'ambiguous':
        await this.db.tenantTx(tenantId, (tx) => tx.update(deliveryState).set({ status: 'ambiguous', errorInfo: { code: 'AMBIGUOUS_SEND', message: result.message } }).where(eq(deliveryState.id, deliveryId)));
        M.outboundResults().inc({ channel: row.channel, result: 'ambiguous' });
        return;
      case 'retryable':
        await this.db.tenantTx(tenantId, (tx) => tx.update(deliveryState).set({ status: 'pending', retryCount: sql`${deliveryState.retryCount} + 1`, errorInfo: { code: 'retryable', message: result.message } }).where(eq(deliveryState.id, deliveryId)));
        if (result.retryAfterMs) throw new RetryLaterError(result.retryAfterMs, 'provider_retry_after');
        throw new Error(`retryable send failure: ${result.message}`);
    }
  }

  /** Delivery receipts update state; acceptance is never reported as delivery (WA-03). */
  async applyReceipt(externalMessageId: string, status: 'delivered' | 'read' | 'failed' | 'sent', error?: { code: string; message: string }): Promise<void> {
    const rank = { pending: 0, sending: 1, sent: 2, delivered: 3, read: 4 } as Record<string, number>;
    await this.db.systemTx(async (tx) => {
      const [row] = await tx.select().from(deliveryState).where(eq(deliveryState.externalMessageId, externalMessageId));
      if (!row) return;
      if (status !== 'failed' && (rank[row.status] ?? 0) >= rank[status]) return; // never regress
      await tx.update(deliveryState).set({
        status, ...(status === 'delivered' ? { deliveredAt: new Date() } : {}), ...(status === 'failed' ? { failedAt: new Date(), errorInfo: error ?? { code: 'provider_failed', message: 'delivery failed' } } : {}),
      }).where(eq(deliveryState.id, row.id));
    });
    M.outboundResults().inc({ result: `receipt_${status}` });
  }

  /**
   * The employee replied: the 24h window is open, so release any digest detail held
   * back behind a template (WA-03).
   */
  async flushDeferred(tenantId: string, userId: string, channel: ChannelName): Promise<number> {
    const pending = await this.db.tenantTx(tenantId, (tx) =>
      tx.select({ id: deliveryState.id, key: deliveryState.idempotencyKey }).from(deliveryState).where(and(eq(deliveryState.userId, userId), eq(deliveryState.channel, channel), isNotNull(deliveryState.deferredPayload), sql`${deliveryState.status} in ('sent','delivered','read')`)),
    );
    let released = 0;
    for (const p of pending) {
      const done = await this.db.tenantTx(tenantId, async (tx) => {
        // Row lock: concurrent replies release the detail exactly once.
        const [r] = await tx.select({ d: deliveryState.deferredPayload }).from(deliveryState).where(and(eq(deliveryState.id, p.id), isNotNull(deliveryState.deferredPayload))).for('update');
        if (!r?.d) return false;
        await tx.update(deliveryState).set({ deferredPayload: null }).where(eq(deliveryState.id, p.id));
        await this.enqueue({ tenantId, userId, channel, messageType: 'digest', content: r.d as unknown as OutboundContent, idempotencyKey: `${p.key}/detail` }, tx);
        return true;
      });
      if (done) released++;
    }
    return released;
  }
}
