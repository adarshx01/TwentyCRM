import { describe, expect, it } from 'vitest';
import { AgentProvider } from '../../src/extraction/agent.provider';

const cfg: any = { agent: { url: 'http://agent:8000', token: 'agent-token-123456' } };
const ctx = { nowIso: '2026-09-28T04:30:00Z', timezone: 'UTC', stageLabels: ['New'], hasActiveDraft: false, cardPresent: false };
const mk = (status: number, body: any, spy?: (u: string, i: any) => void) => new AgentProvider(cfg, (async (u: any, i: any) => { spy?.(String(u), i); return new Response(JSON.stringify(body), { status }); }) as any);

describe('Python agent client', () => {
  it('sends the shared token and only the allowed context, and returns schema-validated data', async () => {
    let seen: any;
    const p = mk(200, { data: { intent: 'search', targetQuery: 'Rajesh' }, usage: { provider: 'langchain-openai', llmTokens: 42 } }, (u, i) => { seen = { u, auth: i.headers.authorization, body: JSON.parse(i.body) }; });
    const r = await p.classifyIntent({ text: 'find rajesh', context: ctx });
    expect(r.data).toEqual({ intent: 'search', targetQuery: 'Rajesh' });
    expect(r.usage.llmTokens).toBe(42);
    expect(seen).toMatchObject({ u: 'http://agent:8000/v1/classify-intent', auth: 'Bearer agent-token-123456' });
    expect(Object.keys(seen.body)).toEqual(['text', 'context']);
  });
  it('re-validates the agent output: authority fields are rejected even if the agent forwards them', async () => {
    await expect(mk(200, { data: { intent: 'archive', tenantId: 'victim' } }).classifyIntent({ text: 'x', context: ctx })).rejects.toThrow();
    await expect(mk(200, { data: { intent: 'drop_database' } }).classifyIntent({ text: 'x', context: ctx })).rejects.toThrow();
  });
  it('maps cards, transcripts and failures', async () => {
    const card = await mk(200, { data: { name: 'Rajesh', phones: ['+91 98765 43210'], legible: true, uncertainFields: [] }, usage: { provider: 'p', visionCalls: 1 } }).extractCard(Buffer.from('img'), 'image/png');
    expect(card.data.phones).toEqual(['+91 98765 43210']); expect(card.usage.visionCalls).toBe(1);
    const t = await mk(200, { text: ' hello ', durationSec: 12.5, usage: { provider: 'p', sttMinutes: 0.2 } }).transcribe(Buffer.from('a'), 'audio/ogg');
    expect(t).toMatchObject({ text: 'hello', durationSec: 12.5 });
    await expect(mk(422, { error: 'model_output_rejected' }).classifyIntent({ text: 'x', context: ctx })).rejects.toThrow(/422/);
    await expect(mk(401, {}).extractEmailFields('x')).rejects.toThrow(/401/);
  });
  it('refuses to run unconfigured', async () => {
    await expect(new AgentProvider({ agent: {} } as any, fetch).classifyIntent({ text: 'x', context: ctx })).rejects.toThrow(/not configured/);
  });
});
