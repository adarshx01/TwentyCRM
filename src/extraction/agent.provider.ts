import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { CardExtractionSchema, EmailExtractionSchema, LlmIntentSchema } from '../common/schemas';
import { FETCH_FN } from '../crm/twenty/twenty-client';
import type { ExtractionProvider, IntentRequest, Usage } from './extraction-provider.interface';

const UsageSchema = z.object({ provider: z.string(), llmTokens: z.number().optional(), sttMinutes: z.number().optional(), visionCalls: z.number().optional() }).passthrough();

/**
 * Client for the Python LangChain conversation agent (`agent/`). The agent runs on the internal network, authenticated
 * with a shared token. Its answers are treated as untrusted: they are validated again here with the strict Zod
 * schemas, so a compromised or confused model still cannot express a tenant, record id, role or tool.
 */
@Injectable()
export class AgentProvider implements ExtractionProvider {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FETCH_FN) private readonly fetchFn: typeof fetch,
  ) {}

  private async call<T>(path: string, body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>, timeoutMs: number): Promise<{ data: T; usage: Usage; raw: any }> {
    const { url, token } = this.config.agent;
    if (!url || !token) throw new Error('agent service is not configured');
    const res = await this.fetchFn(`${url.replace(/\/$/, '')}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`agent returned ${res.status}${res.status === 422 ? ' (model output rejected)' : ''}`);
    const json: any = await res.json();
    return { data: schema.parse(json.data ?? json), usage: UsageSchema.parse(json.usage ?? { provider: 'agent' }) as Usage, raw: json };
  }

  classifyIntent(req: IntentRequest) {
    return this.call('/v1/classify-intent', { text: req.text.slice(0, 4000), context: req.context }, LlmIntentSchema, 30_000).then(({ data, usage }) => ({ data, usage }));
  }

  extractCard(image: Buffer, mimeType: string) {
    return this.call('/v1/extract-card', { imageBase64: image.toString('base64'), mimeType }, CardExtractionSchema, 45_000).then(({ data, usage }) => ({ data, usage }));
  }

  async transcribe(audio: Buffer, mimeType: string) {
    const { raw, usage } = await this.call('/v1/transcribe', { audioBase64: audio.toString('base64'), mimeType }, z.any(), 75_000);
    return { text: String(raw.text ?? '').trim(), durationSec: typeof raw.durationSec === 'number' ? raw.durationSec : undefined, usage };
  }

  extractEmailFields(text: string) {
    return this.call('/v1/extract-email', { text: text.slice(0, 8000) }, EmailExtractionSchema, 30_000).then(({ data, usage }) => ({ data, usage }));
  }
}
