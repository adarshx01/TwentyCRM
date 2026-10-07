import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone, normalizePhoneForMatch } from '../../src/common/utils/phone.util';

describe('phone normalization (CAP-03, CAP-04)', () => {
  it('international numbers become E.164 and keep the raw input', () => {
    const r = normalizePhone('+91 98765 43210');
    expect(r).toMatchObject({ e164: '+919876543210', raw: '+91 98765 43210', country: 'IN', isValid: true });
  });
  it.each([['+1 (415) 555-2671', '+14155552671'], ['+44 20 7946 0958', '+442079460958'], ['+971 50 123 4567', '+971501234567']])('%s', (raw, e164) => expect(normalizePhone(raw).e164).toBe(e164));
  it('a national number is only normalized with an explicit country hint', () => {
    expect(normalizePhone('098765 43210').e164).toBeNull();
    expect(normalizePhone('98765 43210', 'IN').e164).toBe('+919876543210');
  });
  it('invalid, partial and empty numbers keep raw and never invent E.164', () => {
    expect(normalizePhone('12345')).toMatchObject({ e164: null, raw: '12345', isValid: false });
    expect(normalizePhone('   ')).toMatchObject({ e164: null, isValid: false });
    expect(normalizePhone('call me')).toMatchObject({ e164: null, isValid: false });
  });
  it('matching key is stable across formatting', () => {
    expect(normalizePhoneForMatch('+91 98765-43210')).toBe(normalizePhoneForMatch('+919876543210'));
  });
  it('email normalization lowercases and trims', () => expect(normalizeEmail('  Rajesh@ABC.com ')).toBe('rajesh@abc.com'));
});
