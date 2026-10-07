import { DateTime } from 'luxon';

/**
 * Date resolution utility.
 * Uses Luxon for DST-safe timezone handling (REM-01, CAP-05).
 *
 * Design decision: all dates stored as UTC in the database.
 * User-facing dates are resolved using their IANA timezone.
 * Relative dates are resolved against the sender's timezone and message timestamp.
 */

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const MONTH_RE = MONTHS.join('|');
const DAY_RE = DAYS.join('|');

export interface ResolvedDate {
  date: string | null;
  time: string | null;
  timezone: string;
  ambiguous: boolean;
  /** Why the expression could not be resolved safely (shown to the user) */
  reason?: string;
}

/**
 * Parse a clock-time expression ("11 AM", "3pm", "15:30", "noon") into HH:mm.
 * Returns null when no explicit time is present — a time is never invented (CAP-05).
 */
export function parseTimeExpression(expression: string | undefined | null): string | null {
  if (!expression) return null;
  const e = expression.toLowerCase();
  if (/\bnoon\b/.test(e)) return '12:00';
  if (/\bmidnight\b/.test(e)) return '00:00';
  const m = /(?:^|[^\d])(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/.exec(e) ?? /(?:^|[^\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d])/.exec(e);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const mer = m[3]?.replace(/\./g, '');
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === 'pm' && h !== 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Resolve a natural-language date against the sender's timezone and message timestamp (CAP-05).
 *
 * Conventions (every result is shown as an absolute date in the preview and needs confirmation):
 *  - "today", "tomorrow", "day after tomorrow"
 *  - "<weekday>" / "on <weekday>" → the next occurrence strictly after today
 *  - "this <weekday>" → that weekday in the current ISO week if still ahead, else next week
 *  - "next <weekday>" → that weekday in the following ISO week
 *  - "in N days/weeks/months", "next week" (Monday of next week is NOT assumed → ambiguous)
 *  - "29 September [2026]", "September 29", ISO "2026-09-29"
 *  - "dd/mm/yyyy"-style numeric dates are ambiguous when both parts ≤ 12
 * Anything else is reported ambiguous so the assistant asks instead of guessing.
 */
export function resolveRelativeDate(expression: string, timezone: string, referenceTime?: string): ResolvedDate {
  const now = (referenceTime ? DateTime.fromISO(referenceTime, { zone: 'utc' }) : DateTime.utc()).setZone(timezone);
  const today = now.startOf('day');
  const time = parseTimeExpression(expression);
  const lower = expression.toLowerCase().replace(/\s+/g, ' ').trim();
  const out = (d: DateTime): ResolvedDate => ({ date: d.toISODate(), time, timezone, ambiguous: false });
  const ambiguous = (reason: string): ResolvedDate => ({ date: null, time, timezone, ambiguous: true, reason });

  if (!now.isValid) return ambiguous('invalid reference time');
  if (/\bday after tomorrow\b/.test(lower)) return out(today.plus({ days: 1 }).plus({ days: 1 }));
  if (/\btomorrow\b/.test(lower)) return out(today.plus({ days: 1 }));
  if (/\btoday\b|\btonight\b/.test(lower)) return out(today);

  const rel = /\bin (\d{1,3}) (day|week|month)s?\b/.exec(lower);
  if (rel) return out(today.plus({ [`${rel[2]}s`]: Number(rel[1]) } as any));

  const wd = new RegExp(`\\b(next|this|on)?\\s*(${DAY_RE})\\b`).exec(lower);
  if (wd) {
    const target = DAYS.indexOf(wd[2]) + 1;
    const mod = wd[1];
    if (mod === 'next') return out(today.startOf('week').plus({ weeks: 1 }).plus({ days: target - 1 }));
    if (mod === 'this') {
      const d = today.startOf('week').plus({ days: target - 1 });
      return out(d >= today ? d : d.plus({ weeks: 1 }));
    }
    let d = today.plus({ days: 1 });
    while (d.weekday !== target) d = d.plus({ days: 1 });
    return out(d);
  }

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(lower);
  if (iso) {
    const d = DateTime.fromObject({ year: +iso[1], month: +iso[2], day: +iso[3] }, { zone: timezone });
    return d.isValid ? out(d) : ambiguous('that date does not exist');
  }

  const named = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})(?:\\s+(\\d{4}))?\\b`).exec(lower) ?? (() => {
    const m2 = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`).exec(lower);
    return m2 ? [m2[0], m2[2], m2[1], m2[3]] : null;
  })();
  if (named) {
    const day = Number(named[1]);
    const month = MONTHS.indexOf(named[2]) + 1;
    let year = named[3] ? Number(named[3]) : today.year;
    let d = DateTime.fromObject({ year, month, day }, { zone: timezone });
    if (!d.isValid) return ambiguous('that date does not exist');
    if (!named[3] && d < today) { year += 1; d = DateTime.fromObject({ year, month, day }, { zone: timezone }); }
    return out(d);
  }

  const numeric = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(lower);
  if (numeric) {
    const a = +numeric[1]; const b = +numeric[2]; let y = +numeric[3]; if (y < 100) y += 2000;
    if (a <= 12 && b <= 12 && a !== b) return ambiguous('day/month order is unclear');
    const [day, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
    const d = DateTime.fromObject({ year: y, month, day }, { zone: timezone });
    return d.isValid ? out(d) : ambiguous('that date does not exist');
  }

  if (/\bnext week\b|\bnext month\b|\bsoon\b|\blater\b|\bsometime\b/.test(lower)) return ambiguous('that is not a specific date');
  return ambiguous('I could not work out a date');
}

/**
 * Calculate the next UTC execution time for a morning digest.
 * DST-safe: uses Luxon's IANA timezone handling (REM-01).
 */
export function calculateNextRunUtc(
  localDate: string,
  timeStr: string,
  timezone: string,
): string {
  const [hour, minute] = timeStr.split(':').map(Number);
  const [year, month, day] = localDate.split('-').map(Number);

  const localDt = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0 },
    { zone: timezone },
  );

  if (!localDt.isValid) {
    throw new Error(`Invalid date/time: ${localDate} ${timeStr} ${timezone}`);
  }

  return localDt.toUTC().toISO()!;
}

/**
 * Check if a given date is a working day for the tenant.
 * Working days are ISO day numbers: 1=Mon..7=Sun.
 */
export function isWorkingDay(
  date: string,
  workingDays: number[],
  timezone: string,
): boolean {
  const dt = DateTime.fromISO(date, { zone: timezone });
  return workingDays.includes(dt.weekday);
}

/**
 * Get the next working day from a given date.
 */
export function getNextWorkingDay(
  fromDate: string,
  workingDays: number[],
  timezone: string,
): string {
  let dt = DateTime.fromISO(fromDate, { zone: timezone }).plus({ days: 1 });
  while (!workingDays.includes(dt.weekday)) {
    dt = dt.plus({ days: 1 });
  }
  return dt.toISODate()!;
}

/**
 * Format a date for display in a specific timezone.
 */
export function formatDateForDisplay(
  isoDate: string,
  timezone: string,
  includeTime = false,
): string {
  const dt = DateTime.fromISO(isoDate, { zone: timezone });
  if (includeTime) {
    return dt.toFormat('dd MMM yyyy, hh:mm a ZZZZ');
  }
  return dt.toFormat('dd MMM yyyy (cccc)');
}

/** Add N working days (per tenant working-day set) to a local date; DST-safe. */
export function addWorkingDays(fromLocalDate: string, days: number, workingDays: number[], timezone: string): string {
  let dt = DateTime.fromISO(fromLocalDate, { zone: timezone });
  let left = Math.max(0, Math.floor(days));
  if (!workingDays.length) return dt.plus({ days: left }).toISODate()!;
  while (left > 0) {
    dt = dt.plus({ days: 1 });
    if (workingDays.includes(dt.weekday)) left--;
  }
  return dt.toISODate()!;
}
