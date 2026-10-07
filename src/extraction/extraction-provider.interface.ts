import type { CardExtraction, EmailExtraction, LlmIntent } from '../common/schemas';

export const EXTRACTION_PROVIDER = 'EXTRACTION_PROVIDER';

export interface Usage {
  provider: string;
  llmTokens?: number;
  sttMinutes?: number;
  visionCalls?: number;
}

export interface IntentRequest {
  /** The employee's message or transcript — untrusted content */
  text: string;
  /** Minimal, non-sensitive context: nothing about other records or tenants (SEC-02) */
  context: {
    nowIso: string;
    timezone: string;
    stageLabels: string[];
    hasActiveDraft: boolean;
    cardPresent: boolean;
  };
}

/**
 * Provider port for vision, speech-to-text and structured extraction (Section 2).
 * Implementations must return schema-validated data; the caller never trusts raw model text.
 * Swap providers by configuration without touching domain code.
 */
export interface ExtractionProvider {
  extractCard(image: Buffer, mimeType: string): Promise<{ data: CardExtraction; usage: Usage }>;
  transcribe(audio: Buffer, mimeType: string): Promise<{ text: string; durationSec?: number; usage: Usage }>;
  classifyIntent(req: IntentRequest): Promise<{ data: LlmIntent; usage: Usage }>;
  extractEmailFields(text: string): Promise<{ data: EmailExtraction; usage: Usage }>;
}
