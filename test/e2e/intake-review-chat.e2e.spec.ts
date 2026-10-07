import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, waitFor, type TestEnv } from '../helpers/app';
import { FORM_RULES, buttonId, confirmLast, formBody, lastWithButtons, pressButton, rawMail, seedTenant, talk, type SeededTenant } from '../helpers/fixtures';
import { IntakeService } from '../../src/intake/intake.service';
import { DbService } from '../../src/database/db.service';
import { intakeRecords, operations } from '../../src/database/schema';

const AT = { receivedAt: '2026-09-28T04:30:00.000Z' };

describe('chat approval of intake review items uses the normal preview/confirm flow (IN-11, AT-20)', () => {
  let env: TestEnv; let T: SeededTenant; let ws: any; let db: DbService; let intake: IntakeService; let recordId: string;
  beforeAll(async () => {
    env = await createTestEnv({ workers: true });
    T = await seedTenant(env, { slug: 'chat-review', users: [
      { key: 'olivia', displayName: 'Olivia', role: 'salesperson', phone: '+919800000011' },
      { key: 'mgr', displayName: 'Mo Manager', role: 'manager', phone: '+919800000014', managedTeamIds: ['x'] },
    ], extra: { intakeSources: [{ sourceId: 'web', type: 'email_forward', intakeAlias: 'leads@intake.example', parsingRules: FORM_RULES, crmRouting: { initialStage: 'new', sourceTag: 'Website', ownerEmail: 'olivia@chat-review.test', mode: 'review' } }] } });
    ws = env.twenty.workspaces.get('chat-review'); db = env.get(DbService); intake = env.get(IntakeService);
    const r = await intake.receiveEmail({ eventId: 'e1', recipient: 'leads@intake.example', raw: rawMail({ text: formBody({ name: 'Chat Approved', email: 'ca@x.example', message: 'Please approve me' }) }) });
    recordId = r.recordId!;
    await waitFor(async () => (await db.systemTx((tx) => tx.select().from(intakeRecords))).some((x) => x.state === 'review') || undefined, 30000, 300, 'review item');
    await env.startWorkers();
  });
  afterAll(async () => { await env.close(); });

  it('a salesperson cannot list or approve review items', async () => {
    expect((await talk(env, T, 'olivia', 'review', AT)).join('\n')).toMatch(/Only managers, CXOs and administrators/);
    expect((await talk(env, T, 'olivia', `approve ${recordId.slice(0, 8)}`, AT)).join('\n')).toMatch(/Only managers/);
    expect(ws.all('opportunities')).toHaveLength(0);
  });

  it('a manager lists, previews, confirms: one opportunity, committed once even if confirmed twice', async () => {
    const list = (await talk(env, T, 'mgr', 'review', AT)).join('\n');
    expect(list).toContain(recordId.slice(0, 8)); expect(list).toContain('Chat Approved'); expect(list).toMatch(/review mode/);
    const prev = (await talk(env, T, 'mgr', `approve ${recordId.slice(0, 8)}`, AT)).join('\n');
    expect(prev).toContain('Approve website enquiry'); expect(prev).toContain('NOT been saved yet');
    expect(ws.all('opportunities')).toHaveLength(0);
    const confirm = buttonId(lastWithButtons(env, T.users.mgr.id), 'Confirm');
    await pressButton(env, T.users.mgr.phone!, confirm);
    await pressButton(env, T.users.mgr.phone!, confirm);
    await waitFor(async () => (await db.systemTx((tx) => tx.select().from(intakeRecords))).find((x) => x.id === recordId)?.state === 'committed' || undefined, 30000, 300, 'committed');
    expect(ws.all('opportunities')).toHaveLength(1);
    expect(ws.all('people')[0].beeOwnerMemberId).toBe(T.users.olivia.memberId); // owner is the assigned salesperson, not the approver
    expect((await db.tenantTx(T.tenantId, (tx) => tx.select().from(operations))).filter((o) => o.idempotencyKey === `intake:${recordId}`)).toHaveLength(1);
  });

  it('rejecting from chat creates no opportunity', async () => {
    const r = await intake.receiveEmail({ eventId: 'e2', recipient: 'leads@intake.example', raw: rawMail({ text: formBody({ name: 'Reject Me', email: 'rj@x.example', message: 'Spam-ish' }) }) });
    await waitFor(async () => (await db.systemTx((tx) => tx.select().from(intakeRecords))).find((x) => x.id === r.recordId)?.state === 'review' || undefined, 30000, 300, 'review');
    expect((await talk(env, T, 'mgr', `reject ${r.recordId!.slice(0, 8)}`, AT)).join('\n')).toMatch(/Rejected enquiry .* No opportunity was created/);
    expect(ws.all('opportunities')).toHaveLength(1);
  });
});
void confirmLast;
