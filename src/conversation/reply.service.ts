import { Inject, Injectable } from '@nestjs/common';
import { OutboundService } from '../outbound/outbound.service';
import { CHANNEL_SENDERS, type ChannelReply, type ChannelSenders } from '../channels/channel.types';
import type { ChannelName } from '../common/types';
import { getLogger } from '../observability/logger';

/** Sends replies to verified employees (queued, keyed, status-tracked). */
@Injectable()
export class ReplyService {
  private readonly log = getLogger('reply');

  constructor(
    private readonly outbound: OutboundService,
    @Inject(CHANNEL_SENDERS) private readonly senders: ChannelSenders,
  ) {}

  send(target: { tenantId: string; userId: string; channel: ChannelName }, reply: ChannelReply, key: string): Promise<string> {
    return this.outbound.enqueue({ tenantId: target.tenantId, userId: target.userId, channel: target.channel, messageType: 'chat_reply', content: { kind: 'reply', ...reply }, idempotencyKey: key });
  }

  /**
   * Direct reply to an UNVERIFIED sender. Used only for the enrollment handshake the sender
   * initiated; never discloses CRM information (IAM-02). Failures are swallowed.
   */
  async sendDirect(channel: ChannelName, connectionId: string, externalId: string, conversationRef: unknown, reply: ChannelReply, key: string): Promise<void> {
    const sender = this.senders[channel];
    if (!sender) return;
    try {
      await sender.send({ tenantId: '', userId: '', channel, externalId, connectionId, conversationRef }, { kind: 'reply', ...reply }, key);
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'direct reply failed');
    }
  }
}
