import { describe, expect, it } from 'vitest';
import { buildDigestModel, isEmptyDigest, renderDigestText } from '../../src/reminders/digest-builder';
import type { CrmCompany, CrmPerson, CrmTask } from '../../src/crm/crm-adapter.interface';

const TZ = 'Asia/Kolkata';
const task = (o: Partial<CrmTask> & { id: string }): CrmTask => ({ title: 'Follow up', status: 'open', kind: 'follow_up', hasTime: false, archived: false, updatedAt: '2026-09-01T00:00:00Z', ...o });
const person = (id: string, name: string, companyId?: string): CrmPerson => ({ id, name, firstName: name, lastName: '', archived: false, updatedAt: '', companyId });
const company = (id: string, name: string): CrmCompany => ({ id, name, archived: false, updatedAt: '' });
const build = (tasks: CrmTask[], localDate = '2026-09-29') =>
  buildDigestModel({ tasks, people: new Map([['p1', person('p1', 'Rajesh Kumar', 'c1')]]), companies: new Map([['c1', company('c1', 'ABC Industries')]]), timezone: TZ, localDate, urlFor: (id) => `https://crm/t/${id}` });

describe('digest content (REM-02, REM-06)', () => {
  it('orders meetings by time, separates due-today and overdue', () => {
    const m = build([
      task({ id: 'm2', kind: 'meeting', hasTime: true, dueAt: '2026-09-29T09:30:00Z', dueDate: '2026-09-29', title: 'Afternoon demo' }),
      task({ id: 'm1', kind: 'meeting', hasTime: true, dueAt: '2026-09-29T05:30:00Z', dueDate: '2026-09-29', title: 'Morning intro', personId: 'p1' }),
      task({ id: 'd1', dueDate: '2026-09-29', title: 'Send proposal' }),
      task({ id: 'o1', dueDate: '2026-09-25', title: 'Chase invoice' }),
      task({ id: 'o2', dueDate: '2026-09-20', title: 'Old follow-up' }),
      task({ id: 'f1', dueDate: '2026-09-30', title: 'Tomorrow task' }),
    ]);
    expect(m.meetings.map((i) => i.taskId)).toEqual(['m1', 'm2']);
    expect(m.dueToday.map((i) => i.taskId)).toEqual(['d1']);
    expect(m.overdue.map((i) => i.taskId)).toEqual(['o2', 'o1']);
    expect(m.meetings[0]).toMatchObject({ timeLabel: '11:00 AM', contact: 'Rajesh Kumar', company: 'ABC Industries' });
  });
  it('date-only tasks never show an invented time', () => {
    const m = build([task({ id: 'd', dueDate: '2026-09-29', hasTime: false, dueAt: '2026-09-28T18:30:00Z' })]);
    expect(m.dueToday[0].timeLabel).toBeUndefined();
    expect(renderDigestText(m, 'Sam')).not.toMatch(/\d{1,2}:\d{2} (AM|PM)/);
  });
  it('excludes completed, cancelled and archived tasks', () => {
    const m = build([task({ id: 'a', dueDate: '2026-09-29', status: 'done' }), task({ id: 'b', dueDate: '2026-09-29', status: 'cancelled' }), task({ id: 'c', dueDate: '2026-09-29', archived: true }), task({ id: 'ok', dueDate: '2026-09-29' })]);
    expect(m.dueToday.map((i) => i.taskId)).toEqual(['ok']);
  });
  it('derives the local date from dueAt in the user timezone when no date string exists', () => {
    // 2026-09-28T20:00Z is 29 Sep 01:30 in Kolkata → due today (29th), not overdue
    const m = build([task({ id: 'x', dueAt: '2026-09-28T20:00:00Z', hasTime: true })]);
    expect(m.dueToday.map((i) => i.taskId)).toEqual(['x']);
  });
  it('caps the list and discloses the remainder', () => {
    const many = Array.from({ length: 30 }, (_, i) => task({ id: `t${i}`, dueDate: '2026-09-29' }));
    const m = buildDigestModel({ tasks: many, people: new Map(), companies: new Map(), timezone: TZ, localDate: '2026-09-29', urlFor: (id) => id, maxItems: 20 });
    expect(m.dueToday).toHaveLength(20);
    expect(m.hidden).toBe(10);
    expect(renderDigestText(m, 'Sam')).toContain('10 more');
  });
  it('an empty digest is detected so it can be skipped (REM-05)', () => {
    expect(isEmptyDigest(build([]))).toBe(true);
    expect(isEmptyDigest(build([task({ id: 'f', dueDate: '2026-10-05' })]))).toBe(true);
  });
});
