import { describe, expect, it } from 'vitest';
import { normalizeWhatsApp } from '../../src/channels/whatsapp/whatsapp.normalizer';
import { WhatsAppSender } from '../../src/channels/whatsapp/whatsapp.sender';
import { normalizeTeams } from '../../src/channels/teams/teams.normalizer';
import { replyToCard } from '../../src/channels/teams/adaptive-cards';
import { decodeButton, encodeButton } from '../../src/channels/channel.types';
import { planSteps } from '../../src/crm/operations/action-planner';
import { confirmButtons } from '../../src/conversation/preview';
import { hashDraftContent, stableStringify } from '../../src/conversation/draft.service';
import { NormalizedEventSchema } from '../../src/common/schemas';

const waBody = (msg: any) => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '555' }, messages: [msg] } }] }] });

describe('WhatsApp normalization (Section 9)', () => {
  it('text, image, audio, button replies and reply context', () => {
    const t = normalizeWhatsApp(waBody({ id: 'w1', from: '919800000001', timestamp: '1790000000', type: 'text', text: { body: 'Find Rajesh' }, context: { id: 'prev' } })).events[0];
    expect(t).toMatchObject({ providerEventId: 'w1', channel: 'whatsapp', connectionId: '555', externalSenderId: '+919800000001', conversationId: 'wa:555:919800000001', replyToId: 'prev', messageType: 'text', text: 'Find Rajesh' });
    expect(() => NormalizedEventSchema.parse(t)).not.toThrow();
    expect(normalizeWhatsApp(waBody({ id: 'w2', from: '1', type: 'image', image: { id: 'm1', mime_type: 'image/jpeg' } })).events[0]).toMatchObject({ messageType: 'image', media: [{ mediaId: 'm1', mimeType: 'image/jpeg' }] });
    expect(normalizeWhatsApp(waBody({ id: 'w3', from: '1', type: 'audio', audio: { id: 'a1', mime_type: 'audio/ogg; codecs=opus' } })).events[0].messageType).toBe('audio');
    expect(normalizeWhatsApp(waBody({ id: 'w4', from: '1', type: 'interactive', interactive: { button_reply: { id: 'd|x', title: 'Confirm' } } })).events[0].interactiveResponse).toMatchObject({ id: 'd|x' });
  });
  it('delivery receipts are separate from messages; unknown types are ignored', () => {
    const r = normalizeWhatsApp({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '555' }, statuses: [{ id: 'wamid.1', status: 'delivered' }, { id: 'wamid.2', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] }] } }] }] });
    expect(r.events).toHaveLength(0);
    expect(r.statuses).toEqual([{ id: 'wamid.1', status: 'delivered', recipient: undefined, error: undefined }, { id: 'wamid.2', status: 'failed', recipient: undefined, error: { code: 131026, message: 'Undeliverable' } }]);
    expect(normalizeWhatsApp(waBody({ id: 'w5', from: '1', type: 'sticker' })).events).toHaveLength(0);
    expect(normalizeWhatsApp(null)).toEqual({ events: [], statuses: [] });
  });
  it('outbound bodies: text, interactive buttons (max 3, title ≤ 20) and templates', () => {
    const buttons = [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: 'A very long button title indeed' }));
    const b: any = WhatsAppSender.body({ kind: 'reply', text: 'hi', buttons }, '+919800000001', 'en');
    expect(b.to).toBe('919800000001'); expect(b.type).toBe('interactive');
    expect(b.interactive.action.buttons).toHaveLength(3);
    expect(b.interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
    expect((WhatsAppSender.body({ kind: 'reply', text: 'plain' }, '+1', 'en') as any).type).toBe('text');
    const t: any = WhatsAppSender.body({ kind: 'template', name: 'daily_reminder', params: ['Sam', '3'], fallbackText: '' }, '+1', 'en');
    expect(t).toMatchObject({ type: 'template', template: { name: 'daily_reminder', language: { code: 'en' } } });
    expect(t.template.components[0].parameters).toEqual([{ type: 'text', text: 'Sam' }, { type: 'text', text: '3' }]);
  });
});

const teamsActivity = (o: any = {}) => ({ type: 'message', id: 'a1', timestamp: '2026-09-28T04:00:00Z', serviceUrl: 'https://smba.trafficmanager.net/emea/', from: { id: '29:x', aadObjectId: 'aad-1' }, recipient: { id: '28:bot' }, conversation: { id: 'conv-1', conversationType: 'personal', tenantId: 'tenant-1' }, channelData: { tenant: { id: 'tenant-1' } }, text: 'hello', ...o });

describe('Teams normalization (TM-02..TM-04)', () => {
  it('maps tenant + Entra object id from the activity and keeps the conversation reference', () => {
    const n = normalizeTeams(teamsActivity());
    expect(n.event).toMatchObject({ channel: 'teams', connectionId: 'tenant-1', externalSenderId: 'aad-1', conversationId: 'teams:conv-1', messageType: 'text', text: 'hello' });
    expect(n.event!.conversationRef).toMatchObject({ serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'conv-1', tenantId: 'tenant-1' });
    expect(n.nonPersonal).toBe(false);
  });
  it('card submit actions, file uploads and mentions', () => {
    expect(normalizeTeams(teamsActivity({ text: undefined, value: { id: 'd|abc' } })).event).toMatchObject({ messageType: 'card_action', interactiveResponse: { id: 'd|abc' } });
    const f = normalizeTeams(teamsActivity({ text: '', attachments: [{ contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'card.jpg', content: { downloadUrl: 'https://x.sharepoint.com/f', fileType: 'jpg', uniqueId: 'u1' } }] })).event!;
    expect(f).toMatchObject({ messageType: 'image', media: [{ mimeType: 'image/jpeg', filename: 'card.jpg', url: 'https://x.sharepoint.com/f' }] });
    const ch = normalizeTeams(teamsActivity({ conversation: { id: 'c', conversationType: 'channel', tenantId: 'tenant-1' }, text: '<at>Bee</at> pipeline', entities: [{ type: 'mention', mentioned: { id: '28:bot' } }] }));
    expect(ch.nonPersonal).toBe(true); expect(ch.mentioned).toBe(true); expect(ch.event!.text).toBe('pipeline');
    expect(normalizeTeams(teamsActivity({ conversation: { id: 'c', conversationType: 'channel', tenantId: 'tenant-1' } })).mentioned).toBe(false);
  });
  it('only a personal chat can become the proactive destination: a channel mention never carries a conversation reference (TM-04)', () => {
    expect(normalizeTeams(teamsActivity()).event!.conversationRef).toBeDefined();
    const ch = normalizeTeams(teamsActivity({ conversation: { id: 'chan', conversationType: 'channel', tenantId: 'tenant-1' }, entities: [{ type: 'mention', mentioned: { id: '28:bot' } }], text: 'pipeline' }));
    expect(ch.event!.conversationRef).toBeUndefined();
  });
  it('install and uninstall lifecycle events', () => {
    expect(normalizeTeams(teamsActivity({ type: 'installationUpdate', action: 'add' })).lifecycle.kind).toBe('installed');
    expect(normalizeTeams(teamsActivity({ type: 'installationUpdate', action: 'remove' })).lifecycle.kind).toBe('uninstalled');
    expect(normalizeTeams(teamsActivity({ type: 'conversationUpdate', membersRemoved: [{ id: '28:bot' }] })).lifecycle.kind).toBe('uninstalled');
  });
  it('activities without tenant or sender are ignored', () => {
    expect(normalizeTeams(teamsActivity({ from: { id: 'x' } })).event).toBeUndefined();
    expect(normalizeTeams(teamsActivity({ channelData: {}, conversation: { id: 'c' } })).event).toBeUndefined();
  });
  it('Adaptive Card has Submit actions carrying the button id', () => {
    const c: any = replyToCard({ text: '*Draft* saved', buttons: [{ id: 'd|1', title: 'Confirm', style: 'primary' }, { id: 'd|2', title: 'Cancel', style: 'danger' }] });
    expect(c.type).toBe('AdaptiveCard'); expect(c.body[0].text).toContain('**Draft**');
    expect(c.actions[0]).toMatchObject({ type: 'Action.Submit', title: 'Confirm', data: { id: 'd|1' }, style: 'positive' });
    expect(c.actions[1].style).toBe('destructive');
  });
});

describe('draft buttons and content hash (ACT-02)', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  it('button payloads round-trip and malformed ids are rejected', () => {
    const e = encodeButton({ kind: 'draft', draftId: id, version: 3, hash: 'deadbeef', action: 'confirm' });
    expect(decodeButton(e)).toEqual({ kind: 'draft', draftId: id, version: 3, hash: 'deadbeef', action: 'confirm' });
    expect(decodeButton('d|not-a-uuid|1|deadbeef|confirm')).toBeNull();
    expect(decodeButton(`d|${id}|1|deadbeef|drop_tables`)).toBeNull();
    expect(decodeButton('hello')).toBeNull();
  });
  it('any content change changes the hash; key order does not', () => {
    expect(hashDraftContent([{ a: 1, b: 2 }], { x: 1 })).toBe(hashDraftContent([{ b: 2, a: 1 }], { x: 1 }));
    expect(hashDraftContent([{ a: 1 }], { x: 1 })).not.toBe(hashDraftContent([{ a: 2 }], { x: 1 }));
    expect(stableStringify({ b: undefined, a: [1, { d: 1, c: 2 }] })).toBe('{"a":[1,{"c":2,"d":1}]}');
  });
  it('previews carry confirm/edit/cancel bound to version and hash', () => {
    const b = confirmButtons({ id, version: 4, contentHash: 'abcdef0123456789' })!;
    expect(b.map((x) => x.title)).toEqual(['Confirm', 'Edit', 'Cancel']);
    expect(decodeButton(b[0].id)).toMatchObject({ version: 4, hash: 'abcdef01', action: 'confirm' });
  });
});

describe('operation planning is deterministic (ACT-04, ACT-05)', () => {
  it('capture → person, company, opportunity, notes, tasks with stable keys', () => {
    const steps = planSteps({ type: 'capture_lead', person: { name: 'R' }, company: { name: 'C' }, opportunity: { title: 'T', stageId: 'new' }, notes: [{ text: 'n' }], tasks: [{ title: 'a', type: 'follow_up' }, { title: 'b', type: 'call' }] } as any);
    expect(steps.map((s) => `${s.key}:${s.kind}`)).toEqual(['company:create_company', 'person:create_person', 'opportunity:create_opportunity', 'note:0:create_note', 'task:0:create_task', 'task:1:create_task']);
    expect(planSteps({ type: 'capture_lead', person: { name: 'R' }, company: { name: 'C' }, opportunity: { title: 'T', stageId: 'new' }, notes: [], tasks: [] } as any).map((s) => s.key)).toEqual(planSteps({ type: 'capture_lead', person: { name: 'R' }, company: { name: 'C' }, opportunity: { title: 'T', stageId: 'new' }, notes: [], tasks: [] } as any).map((s) => s.key));
  });
  it('existing contact → link + blank fill, never create', () => {
    const steps = planSteps({ type: 'capture_lead', existing: { personId: 'p1' }, personFill: { title: 'CEO' }, opportunity: { title: 'T', stageId: 'new' }, notes: [], tasks: [] } as any);
    expect(steps.map((s) => s.kind)).toEqual(['link_person', 'update_person', 'create_opportunity']);
  });
  it('archive cascades to listed tasks; restore does not', () => {
    expect(planSteps({ type: 'archive', targetType: 'opportunity', targetId: 'o', cascadeTaskIds: ['t1', 't2'] }).map((s) => s.key)).toEqual(['archive', 'archive_task:0', 'archive_task:1']);
    expect(planSteps({ type: 'restore', targetType: 'opportunity', targetId: 'o' })).toHaveLength(1);
  });
});
