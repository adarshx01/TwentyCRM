import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { addWorkingDays, calculateNextRunUtc, isWorkingDay, parseTimeExpression, resolveRelativeDate } from '../../src/common/utils/date.util';

// Reference: Monday 28 Sep 2026, 10:00 in Asia/Kolkata
const REF = DateTime.fromISO('2026-09-28T10:00:00', { zone: 'Asia/Kolkata' }).toUTC().toISO()!;
const r = (e: string, tz = 'Asia/Kolkata', ref = REF) => resolveRelativeDate(e, tz, ref);

describe('parseTimeExpression (CAP-05: never invent a time)', () => {
  it.each([['11 AM', '11:00'], ['3pm', '15:00'], ['12 am', '00:00'], ['12 pm', '12:00'], ['15:30', '15:30'], ['at 9:05 pm', '21:05'], ['noon', '12:00']])('%s → %s', (e, t) => expect(parseTimeExpression(e)).toBe(t));
  it.each(['tomorrow', 'at 3', 'Friday', '', null, undefined, '13 pm', '25:00'])('%s → null', (e) => expect(parseTimeExpression(e as any)).toBeNull());
});

describe('resolveRelativeDate (AT-07, CAP-05)', () => {
  it('today / tomorrow / day after tomorrow', () => {
    expect(r('today').date).toBe('2026-09-28');
    expect(r('tomorrow').date).toBe('2026-09-29');
    expect(r('the day after tomorrow').date).toBe('2026-09-30');
  });
  it('bare weekday is the next occurrence strictly after today', () => {
    expect(r('Monday').date).toBe('2026-10-05');
    expect(r('on Friday').date).toBe('2026-10-02');
  });
  it('"next X" means the following calendar week; "this X" the current week when still ahead', () => {
    expect(r('next Tuesday').date).toBe('2026-10-06');
    expect(r('this Friday').date).toBe('2026-10-02');
    expect(r('this Monday').date).toBe('2026-09-28');
  });
  it('named dates: day-month and month-day, with year roll-over', () => {
    expect(r('29 September').date).toBe('2026-09-29');
    expect(r('September 29th').date).toBe('2026-09-29');
    expect(r('12 January').date).toBe('2027-01-12');
    expect(r('3 March 2027').date).toBe('2027-03-03');
  });
  it('extracts an explicit time without inventing one', () => {
    expect(r('29 September at 11 AM')).toMatchObject({ date: '2026-09-29', time: '11:00' });
    expect(r('next Tuesday').time).toBeNull();
  });
  it('numeric dates are ambiguous when day/month order is unclear', () => {
    const x = r('04/05/2026');
    expect(x.ambiguous).toBe(true);
    expect(r('25/12/2026').date).toBe('2026-12-25');
  });
  it.each(['next week', 'soon', 'sometime later', 'whenever', '31 February', '2026-02-30'])('marks %s ambiguous or invalid, never guesses', (e) => {
    const x = r(e);
    expect(x.ambiguous).toBe(true);
    expect(x.date).toBeNull();
  });
  it('resolves against the sender timezone, not the server timezone', () => {
    // 2026-09-28T22:00Z is already 29 Sep in Kolkata but still 28 Sep in New York
    const ref = '2026-09-28T22:00:00Z';
    expect(r('today', 'Asia/Kolkata', ref).date).toBe('2026-09-29');
    expect(r('today', 'America/New_York', ref).date).toBe('2026-09-28');
  });
});

describe('calculateNextRunUtc across DST (REM-01, AT-08)', () => {
  it('keeps 09:00 local wall-clock time on both sides of a US spring-forward', () => {
    const before = DateTime.fromISO(calculateNextRunUtc('2026-03-06', '09:00', 'America/New_York'), { zone: 'America/New_York' });
    const after = DateTime.fromISO(calculateNextRunUtc('2026-03-09', '09:00', 'America/New_York'), { zone: 'America/New_York' });
    expect(before.toFormat('HH:mm')).toBe('09:00');
    expect(after.toFormat('HH:mm')).toBe('09:00');
    expect(DateTime.fromISO(calculateNextRunUtc('2026-03-06', '09:00', 'America/New_York'), { zone: 'utc' }).hour).toBe(14); // EST = UTC-5
    expect(DateTime.fromISO(calculateNextRunUtc('2026-03-09', '09:00', 'America/New_York'), { zone: 'utc' }).hour).toBe(13); // EDT = UTC-4
  });
  it('handles fall-back and the Europe/London change', () => {
    expect(DateTime.fromISO(calculateNextRunUtc('2026-10-23', '09:00', 'Europe/London'), { zone: 'utc' }).hour).toBe(8); // BST
    expect(DateTime.fromISO(calculateNextRunUtc('2026-10-26', '09:00', 'Europe/London'), { zone: 'utc' }).hour).toBe(9); // GMT
  });
  it('a non-existent local time (spring-forward gap) resolves forward, not to an invalid date', () => {
    const iso = calculateNextRunUtc('2026-03-08', '02:30', 'America/New_York');
    expect(DateTime.fromISO(iso).isValid).toBe(true);
    expect(DateTime.fromISO(iso, { zone: 'America/New_York' }).toFormat('HH:mm')).toBe('03:30');
  });
  it('half-hour offset zones are exact', () => {
    expect(calculateNextRunUtc('2026-09-28', '09:00', 'Asia/Kolkata')).toBe('2026-09-28T03:30:00.000Z');
  });
  it('rejects garbage input', () => {
    expect(() => calculateNextRunUtc('2026-13-40', '09:00', 'Asia/Kolkata')).toThrow();
  });
});

describe('working days', () => {
  it('Mon-Fri', () => {
    expect(isWorkingDay('2026-09-28', [1, 2, 3, 4, 5], 'Asia/Kolkata')).toBe(true);
    expect(isWorkingDay('2026-10-03', [1, 2, 3, 4, 5], 'Asia/Kolkata')).toBe(false); // Saturday
    expect(isWorkingDay('2026-10-04', [1, 2, 3, 4, 5], 'Asia/Kolkata')).toBe(false); // Sunday
  });
  it('addWorkingDays skips weekends', () => {
    expect(addWorkingDays('2026-10-01', 2, [1, 2, 3, 4, 5], 'Asia/Kolkata')).toBe('2026-10-05'); // Thu + 2 = Mon
    expect(addWorkingDays('2026-10-01', 0, [1, 2, 3, 4, 5], 'Asia/Kolkata')).toBe('2026-10-01');
  });
});
