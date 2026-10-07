import type { ChannelName } from '../common/types';

export interface ReplyButton {
  id: string;
  title: string;
  style?: 'primary' | 'danger';
}

/** Channel-neutral reply; adapters render it as text, WhatsApp buttons, or an Adaptive Card. */
export interface ChannelReply {
  text: string;
  buttons?: ReplyButton[];
  /** Pre-rendered Adaptive Card body for Teams (optional; falls back to text + buttons) */
  card?: Record<string, unknown>;
}

export type OutboundContent =
  | ({ kind: 'reply' } & ChannelReply)
  | { kind: 'template'; name: string; params: string[]; fallbackText: string };

export interface SendTarget {
  tenantId: string;
  userId: string;
  channel: ChannelName;
  externalId: string;
  connectionId: string;
  conversationRef?: unknown;
}

export type SendResult =
  | { kind: 'sent'; externalId: string }
  /** Provider answered with a definitive refusal (blocked, template rejected, invalid recipient) */
  | { kind: 'rejected'; code: string; message: string }
  /** Provider answered with a transient error; nothing was accepted */
  | { kind: 'retryable'; message: string; retryAfterMs?: number }
  /** Request may or may not have been accepted (timeout / reset after send) */
  | { kind: 'ambiguous'; message: string };

export interface ChannelSender {
  readonly channel: ChannelName;
  send(target: SendTarget, content: OutboundContent, idempotencyKey: string): Promise<SendResult>;
}

export const CHANNEL_SENDERS = 'CHANNEL_SENDERS';
export type ChannelSenders = Partial<Record<ChannelName, ChannelSender>>;

export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Payload encoded in interactive buttons: draft id, version and short content hash (ACT-02). */
export interface ButtonPayload {
  kind: 'draft';
  draftId: string;
  version: number;
  hash: string;
  action: 'confirm' | 'edit' | 'cancel' | 'update_existing' | 'create_new' | 'skip_note';
}

export const encodeButton = (p: ButtonPayload): string => `d|${p.draftId}|${p.version}|${p.hash}|${p.action}`;

export function decodeButton(id: string): ButtonPayload | null {
  const m = /^d\|([0-9a-f-]{36})\|(\d{1,6})\|([0-9a-f]{8,64})\|(confirm|edit|cancel|update_existing|create_new|skip_note)$/.exec(id);
  return m ? { kind: 'draft', draftId: m[1], version: Number(m[2]), hash: m[3], action: m[4] as ButtonPayload['action'] } : null;
}

export interface MediaFetchContext {
  tenantId: string;
  connectionId: string;
}

/** Fetches attachment bytes from a channel with that channel's credentials and an allowlisted host (SEC-01). */
export interface MediaFetcher {
  fetch(descriptor: { mediaId: string; mimeType: string; url?: string; size?: number }, ctx: MediaFetchContext): Promise<{ data: Buffer; mimeType?: string }>;
}
export const MEDIA_FETCHERS = 'MEDIA_FETCHERS';
export type MediaFetchers = Partial<Record<ChannelName, MediaFetcher>>;
