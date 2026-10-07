import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../database/db.service';
import { usageEvents } from '../database/schema';
import { normalizeEmail, normalizePhone } from '../common/utils/phone.util';
import { EXTRACTION_PROVIDER, type ExtractionProvider, type IntentRequest, type Usage } from './extraction-provider.interface';
import type { CardExtraction, LlmIntent } from '../common/schemas';
import type { TenantContext } from '../common/types';
import { M } from '../observability/metrics';

export interface ExtractedPhone {
  raw: string;
  e164: string | null;
  country: string | null;
  /** True when a country was assumed from tenant config rather than printed (+CC) */
  countryAssumed: boolean;
}

export interface NormalizedCard {
  name?: string;
  title?: string;
  company?: string;
  phones: ExtractedPhone[];
  email?: string;
  website?: string;
  address?: string;
  legible: boolean;
  uncertain: Array<{ field: string; reason: string }>;
}

const EMAIL_SYNTAX = z.string().email();

/**
 * Provider-agnostic extraction with deterministic post-processing (CAP-03, CAP-04).
 * The model only transcribes/structures; normalization, validation and the decision
 * to ask the user are done here in code.
 */
@Injectable()
export class ExtractionService {
  constructor(
    @Inject(EXTRACTION_PROVIDER) private readonly provider: ExtractionProvider,
    private readonly db: DbService,
  ) {}

  private async recordUsage(tenantId: string, kind: string, quantity: number, usage: Usage): Promise<void> {
    if (!quantity) return;
    await this.db.tenantTx(tenantId, (tx) => tx.insert(usageEvents).values({ tenantId, kind, quantity: Math.ceil(quantity), provider: usage.provider }));
    M.tenantUsage().inc({ tenant: tenantId, kind }, quantity);
  }

  /** Normalize raw card extraction: E.164 where country is known, raw always preserved. */
  normalizeCard(raw: CardExtraction, tenant: Pick<TenantContext, 'settings'>): NormalizedCard {
    const uncertain: NormalizedCard['uncertain'] = raw.uncertainFields.map((f) => ({ field: f, reason: 'low confidence reading' }));
    const hint = tenant.settings.defaultCountry;
    const phones = raw.phones.map<ExtractedPhone>((p) => {
      const printedCountry = p.trim().startsWith('+') || p.trim().startsWith('00');
      const r = normalizePhone(p.trim().startsWith('00') ? `+${p.trim().slice(2)}` : p, printedCountry ? undefined : hint);
      if (!printedCountry) uncertain.push({ field: 'phone', reason: r.e164 ? `country code not printed; assumed ${hint}` : 'country code not printed; number kept as written' });
      return { raw: p.trim(), e164: r.e164, country: r.country, countryAssumed: !printedCountry && !!r.e164 };
    });
    let email: string | undefined;
    if (raw.email) {
      const e = normalizeEmail(raw.email);
      if (EMAIL_SYNTAX.safeParse(e).success) email = e;
      else uncertain.push({ field: 'email', reason: 'does not look like a valid email address' });
    }
    if (!raw.legible) uncertain.push({ field: 'card', reason: 'the card was hard to read' });
    return { name: raw.name?.trim() || undefined, title: raw.title?.trim() || undefined, company: raw.company?.trim() || undefined, phones, email, website: raw.website?.trim() || undefined, address: raw.address?.trim() || undefined, legible: raw.legible, uncertain };
  }

  async extractCard(tenant: TenantContext, image: Buffer, mime: string): Promise<NormalizedCard> {
    const end = M.aiDuration().startTimer({ type: 'card' });
    try {
      const { data, usage } = await this.provider.extractCard(image, mime);
      await this.recordUsage(tenant.tenantId, 'vision_calls', usage.visionCalls ?? 1, usage);
      await this.recordUsage(tenant.tenantId, 'llm_tokens', usage.llmTokens ?? 0, usage);
      return this.normalizeCard(data, tenant);
    } finally { end(); }
  }

  async transcribe(tenant: TenantContext, audio: Buffer, mime: string): Promise<{ text: string; durationSec?: number }> {
    const end = M.aiDuration().startTimer({ type: 'stt' });
    try {
      const { text, durationSec, usage } = await this.provider.transcribe(audio, mime);
      await this.recordUsage(tenant.tenantId, 'stt_seconds', Math.ceil((usage.sttMinutes ?? 0) * 60), usage);
      return { text, durationSec };
    } finally { end(); }
  }

  async classify(tenant: TenantContext, req: IntentRequest): Promise<LlmIntent> {
    const end = M.aiDuration().startTimer({ type: 'intent' });
    try {
      const { data, usage } = await this.provider.classifyIntent(req);
      await this.recordUsage(tenant.tenantId, 'llm_tokens', usage.llmTokens ?? 0, usage);
      return data;
    } finally { end(); }
  }

  async extractEmail(tenant: TenantContext, text: string) {
    const { data, usage } = await this.provider.extractEmailFields(text);
    await this.recordUsage(tenant.tenantId, 'llm_tokens', usage.llmTokens ?? 0, usage);
    return data;
  }
}
