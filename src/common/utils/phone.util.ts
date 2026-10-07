import {
  parsePhoneNumberFromString,
  type PhoneNumber,
  type CountryCode,
} from 'libphonenumber-js';

/**
 * Phone number normalization utility.
 * Stores international numbers in E.164 where enough country info exists;
 * always preserves the raw input too (CAP-03).
 */
export interface PhoneResult {
  /** E.164 format if parseable, null otherwise */
  e164: string | null;
  /** Original raw input, always preserved */
  raw: string;
  /** Detected country code */
  country: string | null;
  /** Whether the number is valid */
  isValid: boolean;
}

/**
 * Normalize a phone number to E.164 format.
 * Never infers country code solely from company name (CAP-04).
 *
 * @param raw - Raw phone number string
 * @param defaultCountry - Default country code (from tenant config)
 */
export function normalizePhone(
  raw: string,
  defaultCountry?: string,
): PhoneResult {
  if (!raw || raw.trim().length === 0) {
    return { e164: null, raw, country: null, isValid: false };
  }

  const cleaned = raw.trim();

  try {
    const parsed: PhoneNumber | undefined = parsePhoneNumberFromString(
      cleaned,
      defaultCountry as CountryCode | undefined,
    );

    if (parsed && parsed.isValid()) {
      return {
        e164: parsed.format('E.164'),
        raw: cleaned,
        country: parsed.country || null,
        isValid: true,
      };
    }

    // Try without default country for numbers starting with +
    if (cleaned.startsWith('+')) {
      const parsedIntl = parsePhoneNumberFromString(cleaned);
      if (parsedIntl && parsedIntl.isValid()) {
        return {
          e164: parsedIntl.format('E.164'),
          raw: cleaned,
          country: parsedIntl.country || null,
          isValid: true,
        };
      }
    }

    return { e164: null, raw: cleaned, country: null, isValid: false };
  } catch {
    return { e164: null, raw: cleaned, country: null, isValid: false };
  }
}

/**
 * Normalize phone for duplicate matching (CAP-06).
 * Returns a stripped version for comparison.
 */
export function normalizePhoneForMatch(phone: string): string {
  const result = normalizePhone(phone);
  if (result.e164) {
    return result.e164;
  }
  // Strip all non-digit characters for fuzzy matching
  return phone.replace(/\D/g, '');
}

/**
 * Normalize email for duplicate matching (CAP-06, IN-09).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
