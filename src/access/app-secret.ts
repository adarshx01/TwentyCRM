import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-tenant secret for the CRM Bee app inside Twenty (set as the app's BEE_CHAT_TOKEN variable in that workspace).
 * Derived from one master key so nothing per tenant must be stored, yet a secret taken from tenant A can never speak
 * for tenant B: Bee recomputes the secret for the workspace the caller names and compares.
 */
export function tenantAppSecret(master: string, tenantId: string): string {
  return createHmac('sha256', master).update(`crm-bee-app:v1:${tenantId}`).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
