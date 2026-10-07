import type { NormalizedEvent } from '../../common/schemas';

export interface TeamsConversationRef {
  serviceUrl: string;
  conversationId: string;
  botId?: string;
  userId?: string;
  tenantId: string;
}

export type TeamsLifecycle =
  | { kind: 'installed'; ref: TeamsConversationRef; aadObjectId?: string }
  | { kind: 'uninstalled'; tenantId: string; aadObjectId?: string }
  | { kind: 'ignored' };

const EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', mp4: 'audio/mp4' };
const stripMentions = (text: string) => text.replace(/<at>.*?<\/at>/g, '').replace(/&nbsp;/g, ' ').trim();

export function conversationRefOf(a: any): TeamsConversationRef | null {
  const tenantId = a?.channelData?.tenant?.id ?? a?.conversation?.tenantId;
  if (!a?.serviceUrl || !a?.conversation?.id || !tenantId) return null;
  return { serviceUrl: String(a.serviceUrl), conversationId: String(a.conversation.id), botId: a.recipient?.id, userId: a.from?.id, tenantId: String(tenantId) };
}

/**
 * Normalize a Bot Framework activity (Section 9). Tenant comes from the signed activity's
 * channelData (not from message text); the sender is the Entra object ID (IAM-01/03).
 */
export function normalizeTeams(a: any): { event?: NormalizedEvent; ref?: TeamsConversationRef; lifecycle: TeamsLifecycle; nonPersonal: boolean; mentioned: boolean } {
  const ref = conversationRefOf(a);
  const aad = a?.from?.aadObjectId as string | undefined;
  const personal = (a?.conversation?.conversationType ?? 'personal') === 'personal';
  const mentioned = (a?.entities ?? []).some((e: any) => e?.type === 'mention' && e?.mentioned?.id && e.mentioned.id === a?.recipient?.id);
  const none = { lifecycle: { kind: 'ignored' } as TeamsLifecycle, nonPersonal: !personal, mentioned };

  if (a?.type === 'installationUpdate' && ref) return { ref, lifecycle: a.action === 'remove' ? { kind: 'uninstalled', tenantId: ref.tenantId, aadObjectId: aad } : { kind: 'installed', ref, aadObjectId: aad }, nonPersonal: !personal, mentioned };
  if (a?.type === 'conversationUpdate' && ref) {
    if ((a.membersRemoved ?? []).some((m: any) => m.id === a.recipient?.id)) return { ref, lifecycle: { kind: 'uninstalled', tenantId: ref.tenantId, aadObjectId: aad }, nonPersonal: !personal, mentioned };
    if ((a.membersAdded ?? []).some((m: any) => m.id === a.recipient?.id)) return { ref, lifecycle: { kind: 'installed', ref, aadObjectId: aad }, nonPersonal: !personal, mentioned };
    return { ref, ...none };
  }
  if (a?.type !== 'message' || !ref || !aad || !a.id) return { ref: ref ?? undefined, ...none };

  const base = {
    providerEventId: String(a.id), channel: 'teams' as const, connectionId: ref.tenantId, externalSenderId: aad, conversationId: `teams:${ref.conversationId}`,
    replyToId: a.replyToId ? String(a.replyToId) : undefined, receivedAt: new Date(a.timestamp ?? Date.now()).toISOString(),
    // Only a personal chat may become the proactive-delivery destination; a channel mention must never redirect reminders (TM-04).
    ...(personal ? { conversationRef: ref as unknown as Record<string, unknown> } : {}),
  };
  // Adaptive Card Submit → value.id
  if (a.value?.id && typeof a.value.id === 'string') return { event: { ...base, messageType: 'card_action', interactiveResponse: { type: 'button_reply', id: a.value.id } }, ref, lifecycle: { kind: 'ignored' }, nonPersonal: !personal, mentioned };

  const media: NonNullable<NormalizedEvent['media']> = [];
  for (const att of a.attachments ?? []) {
    if (att.contentType === 'application/vnd.microsoft.teams.file.download.info' && att.content?.downloadUrl) {
      const ft = String(att.content.fileType ?? att.name?.split('.').pop() ?? '').toLowerCase();
      media.push({ mediaId: String(att.content.uniqueId ?? att.name ?? 'file'), mimeType: EXT[ft] ?? 'application/octet-stream', url: String(att.content.downloadUrl), filename: att.name });
    } else if (typeof att.contentType === 'string' && /^(image|audio)\//.test(att.contentType) && att.contentUrl) {
      media.push({ mediaId: String(att.name ?? att.contentUrl.slice(-24)), mimeType: att.contentType, url: String(att.contentUrl), filename: att.name });
    }
  }
  const text = stripMentions(String(a.text ?? '')).slice(0, 8000);
  const messageType = media.length ? (media[0].mimeType.startsWith('audio/') ? 'audio' : media[0].mimeType.startsWith('image/') ? 'image' : 'document') : 'text';
  return { event: { ...base, messageType, text: text || undefined, ...(media.length ? { media } : {}) }, ref, lifecycle: { kind: 'ignored' }, nonPersonal: !personal, mentioned };
}
