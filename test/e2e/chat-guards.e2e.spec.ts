import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, waitFor, type TestEnv } from '../helpers/app';
import { buttonId, confirmLast, lastWithButtons, pressButton, seedRecords, seedTenant, sendText, talk, type SeededTenant } from '../helpers/fixtures';
import { DbService } from '../../src/database/db.service';
import { drafts, schedules } from '../../src/database/schema';
import { inArray } from 'drizzle-orm';

const SAM = '+919800000001';
// Mon 14 Jan 2030 10:00 IST — in the future, so digests for the new date are still eligible (REM-07 skips past dates)
const AT = { receivedAt: '2030-01-14T04:30:00.000Z' };

describe('rescheduling and draft-targeting guards (AT-06, CAP-02, §6)', () => {
  let env: TestEnv; let T: SeededTenant; let ws: any; let db: DbService;
  beforeAll(async () => {
    env = await createTestEnv({ workers: true });
    T = await seedTenant(env, { slug: 'guard-co', users: [{ key: 'sam', displayName: 'Sam', role: 'salesperson', phone: SAM, teamId: 'a' }] });
    ws = env.twenty.workspaces.get('guard-co'); db = env.get(DbService);
    const own = { beeOwnerMemberId: T.users.sam.memberId, beeTeamId: 'a' };
    const person = crypto.randomUUID();
    await seedRecords(env, 'guard-co', {
      people: [{ id: person, name: { firstName: 'Rajesh', lastName: 'Kumar' }, ...own }],
      tasks: [{ id: 'meeting-1', title: 'Demo with Rajesh', beeStatus: 'open', status: 'TODO', beeTaskKind: 'meeting', beeHasTime: true, beeTimezone: 'Asia/Kolkata', beeDueDate: '2030-01-15', dueAt: '2030-01-15T09:30:00.000Z', beePersonId: person, ...own }],
    });
  });
  afterAll(async () => { await env.close(); });

  it('"Move tomorrow\'s meeting to Friday at 3" shows old and new time, replaces the schedule after confirmation, and refreshes the digest', async () => {
    env.extraction.when(/move tomorrow's meeting to friday at 3 pm/i, { intent: 'reschedule', targetQuery: 'Rajesh', dateExpression: 'Friday', timeExpression: '3 PM' });
    const preview = (await talk(env, T, 'sam', "Move tomorrow's meeting to Friday at 3 PM", AT)).join('\n');
    expect(preview).toContain('Demo with Rajesh');
    expect(preview).toMatch(/Old: Tue 15 Jan 2030, 3:00 PM/);
    expect(preview).toMatch(/New: Fri 18 Jan 2030, 3:00 PM Asia\/Kolkata/);
    expect(ws.all('tasks')[0].beeDueDate).toBe('2030-01-15'); // unchanged until confirmed
    await confirmLast(env, T, 'sam');
    const t = ws.all('tasks')[0];
    expect(t).toMatchObject({ beeDueDate: '2030-01-18', beeHasTime: true, dueAt: '2030-01-18T09:30:00.000Z' });
    expect(ws.all('tasks')).toHaveLength(1); // replaced, not duplicated
    const sched = await db.tenantTx(T.tenantId, (tx) => tx.select().from(schedules));
    expect(sched.map((s) => s.localDate)).toContain('2030-01-18'); // REM-03: the new date has a digest, no second action needed
  });

  it('a meeting reschedule without an unambiguous time asks instead of guessing ("at 3" is not 3 AM/PM)', async () => {
    env.extraction.when(/move the meeting to monday at 3$/i, { intent: 'reschedule', targetQuery: 'Rajesh', dateExpression: 'Monday', timeExpression: 'at 3' });
    const r = (await talk(env, T, 'sam', 'move the meeting to Monday at 3', AT)).join('\n');
    expect(r).toMatch(/AM\/PM or use 24-hour time/);
  });

  it('with several open drafts, "confirm" asks which one and "cancel" does not pick for you (CAP-02)', async () => {
    await db.tenantTx(T.tenantId, (tx) => tx.update(drafts).set({ state: 'cancelled' }).where(inArray(drafts.state, ['collecting', 'awaiting_confirmation'])));
    for (const n of ['Alpha', 'Beta']) {
      env.extraction.when(new RegExp(`new lead ${n}$`), { intent: 'capture_lead', person: { name: `${n} Person`, email: `${n.toLowerCase()}@x.example`, companyName: `${n} Co` }, confidence: 0.9 });
      await talk(env, T, 'sam', `new: new lead ${n}`, AT);
    }
    const open = await db.tenantTx(T.tenantId, (tx) => tx.select().from(drafts));
    expect(open.filter((d) => d.state === 'awaiting_confirmation')).toHaveLength(2);
    const r = (await talk(env, T, 'sam', 'confirm', AT)).join('\n');
    expect(r).toMatch(/several open drafts/i);
    expect(ws.all('opportunities')).toHaveLength(0);
    expect((await talk(env, T, 'sam', 'cancel', AT)).join('\n')).toMatch(/several open drafts/i);
    expect((await db.tenantTx(T.tenantId, (tx) => tx.select().from(drafts))).filter((d) => d.state === 'awaiting_confirmation')).toHaveLength(2);
  });

  it('free text never silently attaches to an existing draft: a reply to a specific preview does, a stray message does not', async () => {
    const [d1] = (await db.tenantTx(T.tenantId, (tx) => tx.select().from(drafts))).filter((d) => d.state === 'awaiting_confirmation');
    const before = (d1.extractedData as any).notes.length;
    // a stray message with details is not attached to either draft
    env.extraction.when(/some random note about gamma/i, { intent: 'unknown' });
    await talk(env, T, 'sam', 'some random note about gamma', AT);
    const now = (await db.tenantTx(T.tenantId, (tx) => tx.select().from(drafts))).find((d) => d.id === d1.id)!;
    expect((now.extractedData as any).notes.length).toBe(before);
    // pressing a specific draft's Confirm button is unambiguous even with two open drafts
    const preview = env.whatsapp.sent.filter((m) => m.target.userId === T.users.sam.id && m.content.kind === 'reply' && (m.content as any).buttons?.length && /Alpha Person/.test((m.content as any).text)).at(-1)!;
    const before2 = ws.all('opportunities').length;
    await pressButton(env, SAM, buttonId(preview as any, 'Confirm'));
    await waitFor(() => ws.all('opportunities').length === before2 + 1, 30000, 200, 'alpha saved');
    expect(ws.all('people').map((p: any) => p.name.firstName)).toContain('Alpha');
    expect(ws.all('people').map((p: any) => p.name.firstName)).not.toContain('Beta'); // the other draft stays untouched
    void lastWithButtons; void sendText;
  });
});
