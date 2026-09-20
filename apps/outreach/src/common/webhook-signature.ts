import { timingSafeEqual } from 'crypto';
import { createHmac } from 'crypto';

export function verifyTwentyWebhookSignature(params: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer | string;
}): boolean {
  const { secret, timestamp, signature, rawBody } = params;
  if (!secret || !timestamp || !signature) {
    return false;
  }

  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expectedHex = createHmac('sha256', secret)
    .update(`${timestamp}:${payload}`)
    .digest('hex');

  const received = signature.replace(/^sha256=/i, '').trim();
  try {
    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(received, 'hex');
    if (a.length === 0 || a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
