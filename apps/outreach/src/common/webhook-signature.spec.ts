import { verifyTwentyWebhookSignature } from './webhook-signature';

describe('verifyTwentyWebhookSignature', () => {
  const secret = 'webhook-secret';
  const timestamp = '1710000000';
  const rawBody = '{"event":"opportunity.created"}';

  const signature = require('crypto')
    .createHmac('sha256', secret)
    .update(`${timestamp}:${rawBody}`)
    .digest('hex');

  it('accepts a valid hex HMAC', () => {
    expect(
      verifyTwentyWebhookSignature({
        secret,
        timestamp,
        signature,
        rawBody,
      }),
    ).toBe(true);
  });

  it('accepts a sha256= prefix', () => {
    expect(
      verifyTwentyWebhookSignature({
        secret,
        timestamp,
        signature: `sha256=${signature}`,
        rawBody,
      }),
    ).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(
      verifyTwentyWebhookSignature({
        secret: 'other',
        timestamp,
        signature,
        rawBody,
      }),
    ).toBe(false);
  });

  it('rejects missing headers', () => {
    expect(
      verifyTwentyWebhookSignature({
        secret,
        timestamp: undefined,
        signature,
        rawBody,
      }),
    ).toBe(false);
  });
});
