import { describe, expect, it } from 'vitest';
import { TeamsSender, TeamsTokenProvider } from '../../src/channels/teams/teams.service';

const tokens = { get: async () => 'tok' } as unknown as TeamsTokenProvider;
const target = (ref: any) => ({ tenantId: 't', userId: 'u', channel: 'teams' as const, externalId: 'aad', connectionId: 'ten', conversationRef: ref });
const ref = { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'conv-1', tenantId: 'ten' };
const mk = (status: number, body: any = {}, headers: any = {}) => new TeamsSender(tokens, (async () => new Response(JSON.stringify(body), { status, headers })) as any);

describe('Teams proactive sender (TM-02, AT-11)', () => {
  it('uses the stored conversation reference and sends an Adaptive Card', async () => {
    let seen: any;
    const s = new TeamsSender(tokens, (async (u: any, init: any) => { seen = { u: String(u), body: JSON.parse(init.body), auth: init.headers.Authorization }; return new Response(JSON.stringify({ id: 'msg-1' }), { status: 201 }); }) as any);
    const r = await s.send(target(ref), { kind: 'reply', text: 'hi', buttons: [{ id: 'd|x', title: 'Confirm' }] });
    expect(r).toEqual({ kind: 'sent', externalId: 'msg-1' });
    expect(seen.u).toBe('https://smba.trafficmanager.net/emea/v3/conversations/conv-1/activities');
    expect(seen.auth).toBe('Bearer tok');
    expect(seen.body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
  });
  it('no conversation reference (app uninstalled) is a definitive refusal, not a retry', async () => {
    expect(await mk(200).send(target(null), { kind: 'reply', text: 'x' })).toMatchObject({ kind: 'rejected', code: 'no_conversation_ref' });
  });
  it('refuses untrusted service URLs (no token leakage to attacker hosts)', async () => {
    expect(await mk(200).send(target({ ...ref, serviceUrl: 'https://evil.example/' }), { kind: 'reply', text: 'x' })).toMatchObject({ kind: 'rejected', code: 'bad_service_url' });
  });
  it('403/404 mean uninstalled or gone; 429/5xx are retryable; a dropped connection is ambiguous', async () => {
    expect(await mk(403).send(target(ref), { kind: 'reply', text: 'x' })).toMatchObject({ kind: 'rejected', code: 'teams_unavailable' });
    expect(await mk(404).send(target(ref), { kind: 'reply', text: 'x' })).toMatchObject({ kind: 'rejected', code: 'teams_unavailable' });
    expect(await mk(429, {}, { 'retry-after': '7' }).send(target(ref), { kind: 'reply', text: 'x' })).toMatchObject({ kind: 'retryable', retryAfterMs: 7000 });
    expect((await mk(503).send(target(ref), { kind: 'reply', text: 'x' })).kind).toBe('retryable');
    const dropped = new TeamsSender(tokens, (async () => { throw new Error('socket hang up'); }) as any);
    expect((await dropped.send(target(ref), { kind: 'reply', text: 'x' })).kind).toBe('ambiguous');
  });
});

import { WhatsAppSender } from '../../src/channels/whatsapp/whatsapp.sender';

describe('WhatsApp sender credentials (WA-01: shared number or dedicated client numbers)', () => {
  const cfg: any = { whatsapp: { accessToken: 'platform-token', phoneNumberId: '111', graphVersion: 'v21.0', templateName: 't', templateLanguage: 'en' } };
  const target = { tenantId: 'tenant-1', userId: 'u', channel: 'whatsapp' as const, externalId: '+919800000001', connectionId: '222' };
  const run = async (settings: any) => {
    let seen: any;
    const f = (async (u: any, init: any) => { seen = { url: String(u), auth: init.headers.Authorization }; return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }); }) as any;
    const s = new WhatsAppSender(cfg, f, { getContext: async () => ({ settings }) } as any, { resolve: async (ref: string) => `secret-for-${ref}` } as any);
    const r = await s.send(target, { kind: 'reply', text: 'hi' });
    return { r, seen };
  };
  it('uses the platform token by default and posts from the binding\'s phone-number ID', async () => {
    const { r, seen } = await run({});
    expect(r.kind).toBe('sent'); expect(seen.auth).toBe('Bearer platform-token'); expect(seen.url).toContain('/222/messages');
  });
  it('a client with a dedicated number uses its own secret-referenced token', async () => {
    const { seen } = await run({ whatsappAccessTokenRef: 'env:CLIENT_WA' });
    expect(seen.auth).toBe('Bearer secret-for-env:CLIENT_WA');
  });
  it('maps Meta errors: blocked/undeliverable = rejected, rate limit = retryable, timeout = ambiguous', async () => {
    const mk = (status: number, error: any) => new WhatsAppSender(cfg, (async () => new Response(JSON.stringify({ error }), { status })) as any, { getContext: async () => ({ settings: {} }) } as any, { resolve: async () => 'x' } as any);
    expect(await mk(400, { code: 131026, message: 'undeliverable' }).send(target, { kind: 'reply', text: 'x' })).toMatchObject({ kind: 'rejected', code: 'wa_131026' });
    expect(await mk(400, { code: 132001, message: 'template missing' }).send(target, { kind: 'template', name: 'n', params: [], fallbackText: '' })).toMatchObject({ kind: 'rejected', code: 'wa_132001' });
    expect((await mk(429, { code: 4, message: 'rate' }).send(target, { kind: 'reply', text: 'x' })).kind).toBe('retryable');
    expect((await mk(401, { code: 190, message: 'expired' }).send(target, { kind: 'reply', text: 'x' })).kind).toBe('retryable');
    expect((await mk(500, { message: 'oops' }).send(target, { kind: 'reply', text: 'x' })).kind).toBe('retryable');
    const dropped = new WhatsAppSender(cfg, (async () => { throw new Error('ECONNRESET'); }) as any, { getContext: async () => ({ settings: {} }) } as any, { resolve: async () => 'x' } as any);
    expect((await dropped.send(target, { kind: 'reply', text: 'x' })).kind).toBe('ambiguous');
  });
});
