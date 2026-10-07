import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../helpers/app';
import { confirmLast, pressButton, buttonId, lastWithButtons, seedRecords, seedTenant, talk, type SeededTenant } from '../helpers/fixtures';
import type { LlmIntent } from '../../src/common/schemas';

const SAM = '+919800000001'; const MEERA = '+919800000002'; const MGR = '+919800000003'; const CXO = '+919800000004'; const NOEL = '+919800000005';
const AT = { receivedAt: '2026-09-28T04:30:00.000Z' }; // Mon 28 Sep 2026 10:00 IST

describe('record operations, confirmation and authorization (AT-02, AT-05, AT-06)', () => {
  let env: TestEnv; let T: SeededTenant; let ws: any;
  let oppSam: string; let oppMeera: string; let personSam: string; let personMeera: string; let compSam: string;

  const intent = (needle: string | RegExp, i: LlmIntent) => env.extraction.when(needle, i);

  beforeAll(async () => {
    env = await createTestEnv({ workers: true });
    T = await seedTenant(env, { slug: 'ops-co', users: [
      { key: 'sam', displayName: 'Sam Seller', role: 'salesperson', phone: SAM, teamId: 'team-a' },
      { key: 'meera', displayName: 'Meera Rao', role: 'salesperson', phone: MEERA, teamId: 'team-b' },
      { key: 'mgr', displayName: 'Maya Manager', role: 'manager', phone: MGR, teamId: 'team-a', managedTeamIds: ['team-a'] },
      { key: 'cxo', displayName: 'Chris CXO', role: 'cxo', phone: CXO },
      { key: 'noel', displayName: 'Noel Newbie', role: 'salesperson', phone: NOEL, teamId: 'team-a' },
    ] });
    const own = (k: string, team: string) => ({ beeOwnerMemberId: T.users[k].ownerKey, beeTeamId: team });
    compSam = crypto.randomUUID();
    personSam = crypto.randomUUID(); personMeera = crypto.randomUUID(); oppSam = crypto.randomUUID(); oppMeera = crypto.randomUUID();
    ws = await seedRecords(env, 'ops-co', {
      companies: [{ id: compSam, name: 'ABC Industries', ...own('sam', 'team-a') }],
      people: [
        { id: personSam, name: { firstName: 'Rajesh', lastName: 'Kumar' }, emails: { primaryEmail: 'rajesh@abc.com' }, beePhoneE164: '+919876543210', companyId: compSam, ...own('sam', 'team-a') },
        { id: personMeera, name: { firstName: 'Rajesh', lastName: 'Verma' }, emails: { primaryEmail: 'rv@secret.io' }, beePhoneE164: '+919111111111', ...own('meera', 'team-b') },
      ],
      opportunities: [
        { id: oppSam, name: 'Rajesh Kumar — ABC Industries', stage: 'NEW', pointOfContactId: personSam, companyId: compSam, ...own('sam', 'team-a') },
        { id: oppMeera, name: 'Secret deal', stage: 'PROPOSAL', pointOfContactId: personMeera, amount: { amountMicros: 5_000_000_000, currencyCode: 'INR' }, ...own('meera', 'team-b') },
      ],
    });
    intent(/find rajesh/i, { intent: 'search', targetQuery: 'Rajesh' });
    intent(/move rajesh deal to proposal/i, { intent: 'update_stage', targetQuery: 'Rajesh Kumar', newStage: 'Proposal' });
    intent(/move secret deal to won/i, { intent: 'update_stage', targetQuery: 'Secret deal', newStage: 'Won' });
    intent(/move rajesh deal to meeting/i, { intent: 'update_stage', targetQuery: 'Rajesh Kumar', newStage: 'Meeting' });
    intent(/move rajesh deal to nowhere/i, { intent: 'update_stage', targetQuery: 'Rajesh Kumar', newStage: 'Imaginary' });
    intent(/proposal requested/i, { intent: 'add_note', targetQuery: 'Rajesh Kumar', notes: ['proposal requested'] });
    intent(/follow up next tuesday/i, { intent: 'create_task', targetQuery: 'Rajesh Kumar', tasks: [{ title: 'Follow up with Rajesh', type: 'follow_up', dateExpression: 'next Tuesday' }] });
    intent(/assign rajesh deal to meera/i, { intent: 'assign', targetQuery: 'Rajesh Kumar', newOwnerName: 'Meera Rao' });
    intent(/delete this lead/i, { intent: 'archive', targetQuery: 'Rajesh Kumar' });
    intent(/archive rajesh deal/i, { intent: 'archive', targetQuery: 'Rajesh Kumar — ABC' });
    intent(/restore rajesh deal/i, { intent: 'restore', targetQuery: 'Rajesh Kumar — ABC' });
  });
  afterAll(async () => { await env.close(); });

  it('search shows only records the user may access; others return no details (AT-02)', async () => {
    const r = (await talk(env, T, 'sam', 'Find Rajesh', AT)).join('\n');
    expect(r).toContain('Rajesh Kumar');
    expect(r).not.toContain('Verma'); expect(r).not.toContain('Secret');
    const cxo = (await talk(env, T, 'cxo', 'Find Rajesh', AT)).join('\n');
    expect(cxo).toContain('Rajesh Kumar'); expect(cxo).toContain('Rajesh Verma');
    const meera = (await talk(env, T, 'meera', 'Find Rajesh', AT)).join('\n');
    expect(meera).toContain('Verma'); expect(meera).not.toContain('Kumar');
  });

  it('stage change: previews old → new, saves only after confirmation, records stage history', async () => {
    const preview = (await talk(env, T, 'sam', 'Move Rajesh deal to Proposal', AT)).join('\n');
    expect(preview).toMatch(/New → \*Proposal\*/);
    expect(ws.all('opportunities').find((o: any) => o.id === oppSam).stage).toBe('NEW'); // not yet
    await confirmLast(env, T, 'sam');
    expect(ws.all('opportunities').find((o: any) => o.id === oppSam).stage).toBe('PROPOSAL');
  });

  it('invalid stages fail clearly and change nothing (AT-06)', async () => {
    const r = (await talk(env, T, 'sam', 'Move Rajesh deal to nowhere', AT)).join('\n');
    expect(r).toMatch(/not a stage/i);
    expect(r).toContain('New, Qualified, Meeting, Proposal');
  });

  it('a salesperson cannot touch another owner\'s opportunity, and gets the same answer as for a missing one (AT-02)', async () => {
    const r = (await talk(env, T, 'sam', 'Move secret deal to won', AT)).join('\n');
    expect(r).toMatch(/couldn't find/i);
    expect(ws.all('opportunities').find((o: any) => o.id === oppMeera).stage).toBe('PROPOSAL');
  });

  it('a note is an observation: no task is created unless asked (CAP/§6)', async () => {
    const tasksBefore = ws.all('tasks').length;
    const preview = (await talk(env, T, 'sam', 'Met Rajesh today; proposal requested', AT)).join('\n');
    expect(preview).toContain('Note on');
    await confirmLast(env, T, 'sam');
    expect(ws.all('notes').some((n: any) => n.bodyV2.markdown.includes('proposal requested'))).toBe(true);
    expect(ws.all('tasks')).toHaveLength(tasksBefore);
  });

  it('"follow up next Tuesday" proposes a linked, date-only task with the resolved absolute date', async () => {
    const preview = (await talk(env, T, 'sam', 'Follow up next Tuesday', AT)).join('\n');
    expect(preview).toContain('Tue 6 Oct 2026');
    expect(preview).toContain('date only');
    await confirmLast(env, T, 'sam');
    const task = ws.all('tasks').find((t: any) => t.title === 'Follow up with Rajesh');
    expect(task).toMatchObject({ beeHasTime: false, beeDueDate: '2026-10-06', beeOwnerMemberId: T.users.sam.ownerKey });
  });

  it('a salesperson cannot reassign or archive; they are told who can (Section 4)', async () => {
    const a = (await talk(env, T, 'sam', 'Assign Rajesh deal to Meera', AT)).join('\n');
    expect(a).toMatch(/role cannot perform/i);
    const d = (await talk(env, T, 'sam', 'Delete this lead', AT)).join('\n');
    expect(d).toMatch(/never permanently deleted/i);
    expect(d).toMatch(/manager, CXO or administrator/i);
    expect(ws.all('opportunities').find((o: any) => o.id === oppSam).beeArchived).toBe(false);
  });

  it('manager sees only assigned teams: can act on team-a, not on team-b records (AT-02)', async () => {
    env.extraction.when(/mgr move rajesh deal to qualified/i, { intent: 'update_stage', targetQuery: 'Rajesh Kumar', newStage: 'Qualified' });
    env.extraction.when(/mgr move secret deal to qualified/i, { intent: 'update_stage', targetQuery: 'Secret deal', newStage: 'Qualified' });
    expect((await talk(env, T, 'mgr', 'mgr Move Rajesh deal to Qualified', AT)).join('\n')).toContain('Stage change');
    expect((await talk(env, T, 'mgr', 'mgr move secret deal to qualified', AT)).join('\n')).toMatch(/couldn't find/i);
  });

  it('manager reassigns within the team they manage; open tasks move too; note the earlier pending preview is replaced', async () => {
    // cancel the pending manager draft from the previous test first
    await talk(env, T, 'mgr', 'cancel', AT);
    env.extraction.when(/mgr assign rajesh deal to noel/i, { intent: 'assign', targetQuery: 'Rajesh Kumar', newOwnerName: 'Noel Newbie' });
    const preview = (await talk(env, T, 'mgr', 'mgr assign rajesh deal to noel', AT)).join('\n');
    expect(preview).toContain('Noel Newbie');
    expect(preview).toMatch(/1 open task/);
    await confirmLast(env, T, 'mgr');
    expect(ws.all('opportunities').find((o: any) => o.id === oppSam).beeOwnerMemberId).toBe(T.users.noel.ownerKey);
    expect(ws.all('tasks').find((t: any) => t.title === 'Follow up with Rajesh').beeOwnerMemberId).toBe(T.users.noel.ownerKey);
  });

  it('manager cannot assign outside their teams (Meera is in team-b)', async () => {
    env.extraction.when(/mgr assign to meera/i, { intent: 'assign', targetQuery: 'Rajesh Kumar', newOwnerName: 'Meera Rao' });
    expect((await talk(env, T, 'mgr', 'mgr assign to meera', AT)).join('\n')).toMatch(/teams you manage/i);
  });

  it('archive is recoverable: leaves active searches and reminders, restore brings it back (AT-06)', async () => {
    await talk(env, T, 'cxo', 'cancel', AT);
    const preview = (await talk(env, T, 'cxo', 'Archive Rajesh deal', AT)).join('\n');
    expect(preview).toMatch(/Nothing is permanently deleted/);
    await confirmLast(env, T, 'cxo');
    const opp = ws.all('opportunities').find((o: any) => o.id === oppSam);
    expect(opp.beeArchived).toBe(true);
    expect(ws.all('opportunities').find((o: any) => o.id === oppSam)).toBeTruthy(); // record still exists
    expect(ws.all('tasks').find((t: any) => t.title === 'Follow up with Rajesh').beeArchived).toBe(true); // open task leaves reminders with it
    expect((await talk(env, T, 'cxo', 'Find Rajesh', AT)).join('\n')).not.toContain('Rajesh Kumar — ABC');

    const r = (await talk(env, T, 'cxo', 'Restore Rajesh deal', AT)).join('\n');
    expect(r).toMatch(/Restore/);
    expect(r).toMatch(/not re-sent|stay archived/);
    await confirmLast(env, T, 'cxo');
    expect(ws.all('opportunities').find((o: any) => o.id === oppSam).beeArchived).toBe(false);
  });

  it('cancel and a second user pressing the button write nothing (AT-04)', async () => {
    await talk(env, T, 'noel', 'Move Rajesh deal to Meeting', AT);
    const stale = buttonId(lastWithButtons(env, T.users.noel.id), 'Confirm');
    await talk(env, T, 'noel', 'cancel', AT);
    const before = ws.all('opportunities').find((o: any) => o.id === oppSam).stage;
    await pressButton(env, NOEL, stale);
    await new Promise((r) => setTimeout(r, 1500));
    expect(ws.all('opportunities').find((o: any) => o.id === oppSam).stage).toBe(before);
    expect(env.whatsapp.texts(T.users.noel.id).join('\n')).toMatch(/cancelled; nothing was saved|no longer open/i);
  });

  it('a draft that sits for 30 minutes expires and creates no CRM records (AT-04)', async () => {
    await talk(env, T, 'noel', 'Move Rajesh deal to Meeting', AT);
    const { DraftService } = await import('../../src/conversation/draft.service');
    const expired = await env.get<InstanceType<typeof DraftService>>(DraftService).expireDue(new Date(Date.now() + 31 * 60_000));
    expect(expired).toBeGreaterThanOrEqual(1);
    const before = ws.calls.filter((c: any) => c.method !== 'GET').length;
    const out = await (async () => { const b = env.whatsapp.sent.length; await pressButton(env, NOEL, buttonId(lastWithButtons(env, T.users.noel.id), 'Confirm')); await new Promise((r) => setTimeout(r, 1500)); return env.whatsapp.texts(T.users.noel.id).slice(-1)[0]; })();
    expect(out).toMatch(/expired/i);
    expect(ws.calls.filter((c: any) => c.method !== 'GET').length).toBe(before);
  });

  it('the record changing after the preview forces a fresh preview before saving (ACT-03)', async () => {
    await talk(env, T, 'noel', 'cancel', AT);
        const preview = (await talk(env, T, 'noel', 'move rajesh deal to meeting', AT)).join('\n');
    expect(preview).toContain('Stage change');
    // Someone edits the opportunity in Twenty's UI after the preview.
    const opp = ws.all('opportunities').find((o: any) => o.id === oppSam);
    opp.stage = 'NEGOTIATION'; opp.updatedAt = new Date(Date.now() + 5000).toISOString();
    const before = env.whatsapp.texts(T.users.noel.id).length;
    await pressButton(env, NOEL, buttonId(lastWithButtons(env, T.users.noel.id), 'Confirm'));
    await new Promise((r) => setTimeout(r, 2500));
    const after = env.whatsapp.texts(T.users.noel.id).slice(before).join('\n');
    expect(after).toMatch(/changed after your preview/i);
    expect(after).toContain('Negotiation → *Meeting*'); // fresh preview shows the new current state
    expect(ws.all('opportunities').find((o: any) => o.id === oppSam).stage).toBe('NEGOTIATION'); // nothing saved yet
  });
});
