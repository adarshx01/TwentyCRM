import type { NormalizedEvent } from '../../common/schemas';

export interface WhatsAppStatus { id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; recipient?: string; error?: { code: number; message: string } }

/** Normalize a Meta Cloud API webhook body (Section 9). Unknown shapes are ignored, never trusted. */
export function normalizeWhatsApp(body: any): { events: NormalizedEvent[]; statuses: WhatsAppStatus[] } {
  const events: NormalizedEvent[] = [];
  const statuses: WhatsAppStatus[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
      if (!v || change.field !== 'messages') continue;
      const phoneNumberId: string | undefined = v.metadata?.phone_number_id;
      for (const s of v.statuses ?? []) {
        if (s?.id && ['sent', 'delivered', 'read', 'failed'].includes(s.status)) {
          statuses.push({ id: s.id, status: s.status, recipient: s.recipient_id, error: s.errors?.[0] ? { code: s.errors[0].code, message: String(s.errors[0].title ?? s.errors[0].message ?? '') } : undefined });
        }
      }
      if (!phoneNumberId) continue;
      for (const m of v.messages ?? []) {
        if (!m?.id || !m?.from) continue;
        const base = {
          providerEventId: String(m.id), channel: 'whatsapp' as const, connectionId: String(phoneNumberId), externalSenderId: `+${String(m.from).replace(/^\+/, '')}`,
          conversationId: `wa:${phoneNumberId}:${m.from}`, replyToId: m.context?.id ? String(m.context.id) : undefined,
          receivedAt: new Date((Number(m.timestamp) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        };
        switch (m.type) {
          case 'text': events.push({ ...base, messageType: 'text', text: String(m.text?.body ?? '').slice(0, 8000) }); break;
          case 'image': events.push({ ...base, messageType: 'image', text: m.image?.caption, media: [{ mediaId: String(m.image.id), mimeType: String(m.image.mime_type ?? 'image/jpeg') }] }); break;
          case 'audio': events.push({ ...base, messageType: 'audio', media: [{ mediaId: String(m.audio.id), mimeType: String(m.audio.mime_type ?? 'audio/ogg') }] }); break;
          case 'document': events.push({ ...base, messageType: 'document', text: m.document?.caption, media: [{ mediaId: String(m.document.id), mimeType: String(m.document.mime_type ?? 'application/octet-stream'), filename: m.document.filename }] }); break;
          case 'interactive': {
            const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
            if (r?.id) events.push({ ...base, messageType: 'interactive', interactiveResponse: { type: m.interactive.button_reply ? 'button_reply' : 'list_reply', id: String(r.id), title: r.title } });
            break;
          }
          case 'button': if (m.button?.payload) events.push({ ...base, messageType: 'interactive', interactiveResponse: { type: 'button_reply', id: String(m.button.payload), title: m.button.text } }); break;
          default: break; // reactions, stickers, locations… are ignored
        }
      }
    }
  }
  return { events, statuses };
}
