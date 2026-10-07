import type { CardExtraction, EmailExtraction, LlmIntent } from '../../src/common/schemas';
import type { ExtractionProvider, IntentRequest } from '../../src/extraction/extraction-provider.interface';
import type { ChannelSender, MediaFetcher, OutboundContent, SendResult, SendTarget } from '../../src/channels/channel.types';

// ── media fixtures ─────────────────────────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG-looking file carrying a marker the fake vision provider reads. */
export const cardImage = (key: string): Buffer => Buffer.concat([PNG_SIG, Buffer.from(`CARD:${key}`)]);

/** A tiny, valid WAV (so duration parsing works) whose data chunk carries a marker. */
export function voiceNote(key: string, seconds = 1): Buffer {
  const marker = Buffer.from(`VOICE:${key}\0`);
  const sampleRate = 8000;
  const data = Buffer.concat([marker, Buffer.alloc(Math.max(0, sampleRate * seconds - marker.length))]);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export class FakeExtraction implements ExtractionProvider {
  cards = new Map<string, CardExtraction>();
  transcripts = new Map<string, string>();
  intentRules: Array<(req: IntentRequest) => LlmIntent | undefined> = [];
  intentCalls: IntentRequest[] = [];
  failIntent = false;
  failCard = 0;

  async extractCard(image: Buffer) {
    if (this.failCard > 0) { this.failCard--; throw new Error('vision provider unavailable'); }
    const key = /CARD:([\w-]+)/.exec(image.toString('latin1'))?.[1] ?? '';
    const data = this.cards.get(key);
    if (!data) throw new Error(`no card fixture ${key}`);
    return { data, usage: { provider: 'fake', visionCalls: 1 } };
  }
  async transcribe(audio: Buffer) {
    const key = /VOICE:([\w-]+)/.exec(audio.toString('latin1'))?.[1] ?? '';
    return { text: this.transcripts.get(key) ?? '', durationSec: 5, usage: { provider: 'fake', sttMinutes: 0.1 } };
  }
  async classifyIntent(req: IntentRequest) {
    this.intentCalls.push(req);
    if (this.failIntent) throw new Error('llm unavailable');
    for (const rule of this.intentRules) { const r = rule(req); if (r) return { data: r, usage: { provider: 'fake', llmTokens: 100 } }; }
    return { data: { intent: 'unknown' } as LlmIntent, usage: { provider: 'fake', llmTokens: 10 } };
  }
  async extractEmailFields(): Promise<{ data: EmailExtraction; usage: { provider: string } }> {
    return { data: { evidence: {} }, usage: { provider: 'fake' } };
  }
  /** Convenience: route texts containing `needle` to an intent. */
  when(needle: string | RegExp, intent: LlmIntent): this {
    this.intentRules.push((req) => ((typeof needle === 'string' ? req.text.includes(needle) : needle.test(req.text)) ? intent : undefined));
    return this;
  }
}

export interface SentMessage { target: SendTarget; content: OutboundContent; key: string }

/** Channel sender that records messages; behaviour per call is scriptable. */
export class RecordingSender implements ChannelSender {
  sent: SentMessage[] = [];
  results: SendResult[] = [];
  constructor(readonly channel: 'whatsapp' | 'teams') {}
  async send(target: SendTarget, content: OutboundContent, key: string): Promise<SendResult> {
    const scripted = this.results.shift();
    if (scripted) { if (scripted.kind === 'sent') this.sent.push({ target, content, key }); return scripted; }
    this.sent.push({ target, content, key });
    return { kind: 'sent', externalId: `ext-${this.channel}-${this.sent.length}` };
  }
  texts(userId?: string): string[] {
    return this.sent.filter((m) => !userId || m.target.userId === userId).map((m) => (m.content.kind === 'reply' ? m.content.text : `[template ${m.content.name}] ${m.content.fallbackText}`));
  }
  last(userId?: string): SentMessage | undefined { const l = this.sent.filter((m) => !userId || m.target.userId === userId); return l[l.length - 1]; }
  clear() { this.sent = []; }
}

/** Media fetcher that serves buffers registered by media id. */
export class FakeMediaFetcher implements MediaFetcher {
  files = new Map<string, { data: Buffer; mimeType: string }>();
  async fetch(d: { mediaId: string; mimeType: string }) {
    const f = this.files.get(d.mediaId);
    if (!f) throw new Error(`no media ${d.mediaId}`);
    return { data: f.data, mimeType: f.mimeType };
  }
}
