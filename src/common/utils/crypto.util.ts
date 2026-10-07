import { createHmac, randomBytes, createHash, timingSafeEqual as nodeTimingSafeEqual } from 'crypto';

/**
 * Verify WhatsApp webhook signature (HMAC-SHA256).
 */
export function verifyWhatsAppSignature(
  payload: string | Buffer,
  signature: string,
  appSecret: string,
): boolean {
  const expectedSignature = createHmac('sha256', appSecret)
    .update(payload)
    .digest('hex');
  const expected = `sha256=${expectedSignature}`;
  return timingSafeEqual(expected, signature);
}

/**
 * Generate a content hash for draft versioning (ACT-02).
 */
export function generateContentHash(content: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex');
}

/**
 * Generate a secure random token for enrollment links (IAM-02).
 */
export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Generate a correlation ID for request tracing.
 */
export function generateCorrelationId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return nodeTimingSafeEqual(bufA, bufB);
}

/**
 * Generate a bounded content fingerprint for email dedup (IN-08).
 * Uses first N characters of normalized content.
 */
export function contentFingerprint(content: string, maxLength = 500): string {
  const normalized = content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLength);
  return createHash('sha256').update(normalized).digest('hex').substring(0, 32);
}
