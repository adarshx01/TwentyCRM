import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, waitFor, type TestEnv } from '../helpers/app';
import { buttonId, lastWithButtons, pressButton, seedTenant, sendMedia, sendText, type SeededTenant } from '../helpers/fixtures';
import { cardImage, voiceNote } from '../helpers/fakes';
import { DbService } from '../../src/database/db.service';
import { drafts, operations, auditLog } from '../../src/database/schema';
import { eq } from 'drizzle-orm';

const PHONE = '+919800000001';
// Messages are timestamped Mon 28 Sep 2026 10:00 IST so relative/named dates are deterministic (CAP-05).
const AT = { receivedAt: '2026-09-28T04:30:00.000Z' };

describe('card + voice capture end to end (AT-03, AT-04, CAP-*, ACT-*)', () => {
  let env: TestEnv; let T: SeededTenant; let ws: ReturnType<TestEnv['twenty']['addWorkspace']>;

  beforeAll(async () => {
    env = await createTestEnv({ workers: true });
    T = await seedTenant(env, { slug: 'capture-co', users: [{ key: 'sam', displayName: 'Sam Seller', role: 'salesperson', phone: PHONE, teamId: 'team-a' }] });
    ws = env.twenty.workspaces.get('capture-co')!;
    env.extraction.cards.set('rajesh', { name: 'Rajesh Kumar', title: 'CEO', company: 'ABC Industries', phones: ['+91 98765 43210'], email: 'Rajesh@ABC.com', website: 'abc.com', legible: true, uncertainFields: [] });
    env.extraction.transcripts.set('v1', 'Met Rajesh from ABC Industries. Interested in demand forecasting. Meet him on 29 September at 11 AM.');
    env.extraction.when(/Met Rajesh/, { intent: 'capture_lead', person: { name: 'Rajesh', companyName: 'ABC Industries' }, interest: 'demand forecasting', tasks: [{ title: 'Meeting with Rajesh', type: 'meeting', dateExpression: '29 September', timeExpression: '11 AM' }], confidence: 0.95 });
    env.media.files.set('img1', { data: cardImage('rajesh'), mimeType: 'image/png' });
    env.media.files.set('aud1', { data: voiceNote('v1'), mimeType: 'audio/wav' });
  });
  afterAll(async () => { await env.close(); });

  const say = () => env.whatsapp.texts(T.users.sam.id);

  it('card → asks for context → voice note → ONE combined preview; nothing saved yet', async () => {
    await sendMedia(env, PHONE, 'image', 'img1', 'image/png', AT);
    await waitFor(() => say().some((t) => /continue without a note|Add context/i.test(t)), 15000, 100, 'context prompt');
    await sendMedia(env, PHONE, 'audio', 'aud1', 'audio/wav', AT);
    const preview = await waitFor(() => lastWithButtons(env, T.users.sam.id)?.content.kind === 'reply' && (lastWithButtons(env, T.users.sam.id)!.content as any).text.includes('Draft lead'), 20000, 100, 'preview');
    expect(preview).toBeTruthy();
    const text = (lastWithButtons(env, T.users.sam.id)!.content as any).text as string;
    expect(text).toContain('Rajesh Kumar');
    expect(text).toContain('+919876543210');
    expect(text).toContain('rajesh@abc.com');
    expect(text).toContain('ABC Industries');
    expect(text).toContain('demand forecasting');
    expect(text).toMatch(/Tue 29 Sep 2026, 11:00 AM Asia\/Kolkata/);
    expect(text).toContain('NOT been saved yet');
    const titles = (lastWithButtons(env, T.users.sam.id)!.content as any).buttons.map((b: any) => b.title);
    expect(titles).toEqual(['Confirm', 'Edit', 'Cancel']);
    // CAP-07/ACT-01: no CRM writes before confirmation
    expect(ws.all('people')).toHaveLength(0);
    expect(ws.all('opportunities')).toHaveLength(0);
  });

  let staleConfirm: string; let freshConfirm: string;

  it('a correction bumps the version and invalidates the older buttons', async () => {
    staleConfirm = buttonId(lastWithButtons(env, T.users.sam.id), 'Confirm');
    const before = env.whatsapp.sent.length;
    await sendText(env, PHONE, 'phone +91 90000 11111', AT);
    await waitFor(() => env.whatsapp.sent.length > before && /90000 11111|\+919000011111/.test(say().join('\n')), 15000, 100, 'updated preview');
    const text = (lastWithButtons(env, T.users.sam.id)!.content as any).text as string;
    expect(text).toContain('+919000011111');
    expect(text).toMatch(/your edit/);
    freshConfirm = buttonId(lastWithButtons(env, T.users.sam.id), 'Confirm');
    expect(freshConfirm).not.toBe(staleConfirm);
  });

  it('replaying the OLD confirm button writes nothing (AT-04)', async () => {
    const before = env.whatsapp.sent.length;
    await pressButton(env, PHONE, staleConfirm);
    await waitFor(() => env.whatsapp.sent.length > before, 15000, 100, 'stale reply');
    expect(say().join('\n')).toMatch(/out of date/i);
    expect(ws.all('people')).toHaveLength(0);
  });

  it('another user cannot confirm this draft (AT-04)', async () => {
    const other = await seedTenant(env, { slug: 'other-co', users: [{ key: 'eve', displayName: 'Eve', role: 'salesperson', phone: '+919800000099' }] });
    const before = env.whatsapp.sent.length;
    await pressButton(env, '+919800000099', freshConfirm, { conversationId: 'wa:1000000001:919800000099' });
    await waitFor(() => env.whatsapp.sent.some((m) => m.target.userId === other.users.eve.id), 15000, 100, 'reply to eve');
    expect(env.whatsapp.texts(other.users.eve.id).join(' ')).toMatch(/couldn't find that draft/i);
    expect(ws.all('people')).toHaveLength(0);
    expect(env.whatsapp.sent.length).toBeGreaterThan(before);
  });

  it('confirm → one person, company, opportunity, note and task with correct relations; reports exactly what was saved', async () => {
    await pressButton(env, PHONE, freshConfirm);
    await waitFor(() => say().some((t) => /✅ Saved/.test(t)), 30000, 100, 'saved message');
    expect(ws.all('people')).toHaveLength(1);
    expect(ws.all('companies')).toHaveLength(1);
    expect(ws.all('opportunities')).toHaveLength(1);
    expect(ws.all('notes')).toHaveLength(1);
    expect(ws.all('tasks')).toHaveLength(1);
    const [person] = ws.all('people'); const [company] = ws.all('companies'); const [opp] = ws.all('opportunities'); const [task] = ws.all('tasks'); const [note] = ws.all('notes');
    expect(person.name).toEqual({ firstName: 'Rajesh', lastName: 'Kumar' });
    expect(person.beePhoneE164).toBe('+919000011111');
    expect(person.beePhoneRaw).toBe('+91 90000 11111');
    expect(person.companyId).toBe(company.id);
    expect(person.beeOwnerMemberId).toBe(T.users.sam.memberId);
    expect(opp.pointOfContactId).toBe(person.id); expect(opp.companyId).toBe(company.id); expect(opp.stage).toBe('NEW');
    expect(task.beeHasTime).toBe(true); expect(task.beeTaskKind).toBe('meeting'); expect(task.dueAt).toBe('2026-09-29T05:30:00.000Z');
    expect(ws.all('taskTargets').map((t) => t.opportunityId)).toContain(opp.id);
    expect(ws.all('noteTargets').map((t) => t.personId)).toContain(person.id);
    expect(note.bodyV2.markdown).toContain('Met Rajesh');
    const msg = say().find((t) => /✅ Saved/.test(t))!;
    expect(msg).toMatch(/OP-[0-9A-F]{8}/);
    expect(msg).toContain(`/object/opportunity/${opp.id}`);
  });

  it('confirming the same version again returns the same result and creates nothing new (ACT-05)', async () => {
    const before = env.whatsapp.sent.length;
    await pressButton(env, PHONE, freshConfirm);
    await waitFor(() => env.whatsapp.sent.length > before, 15000, 100, 'duplicate reply');
    expect(ws.all('people')).toHaveLength(1);
    expect(ws.all('opportunities')).toHaveLength(1);
    const ops = await env.get<DbService>(DbService).tenantTx(T.tenantId, (tx) => tx.select().from(operations));
    expect(ops).toHaveLength(1);
    expect(ops[0].state).toBe('committed');
  });

  it('the draft and journal are committed, and every step was audited (SEC-03)', async () => {
    const db = env.get<DbService>(DbService);
    const ds = await db.tenantTx(T.tenantId, (tx) => tx.select().from(drafts));
    expect(ds.map((d) => d.state)).toEqual(['committed']);
    const [op] = await db.tenantTx(T.tenantId, (tx) => tx.select().from(operations));
    expect((op.steps as any[]).every((s) => s.status === 'committed' && s.externalId)).toBe(true);
    const audit = await db.tenantTx(T.tenantId, (tx) => tx.select().from(auditLog));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['draft.created', 'draft.confirmed', 'operation.capture_lead']));
    expect(audit.every((a) => a.correlationId !== undefined)).toBe(true);
  });
});
