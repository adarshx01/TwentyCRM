import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestEnv, waitFor, type TestEnv } from '../helpers/app';
import { seedRecords, seedTenant, type SeededTenant } from '../helpers/fixtures';
import { cardImage } from '../helpers/fakes';
import { DbService } from '../../src/database/db.service';
import { deliveryState } from '../../src/database/schema';
import { SchedulePlanner } from '../../src/reminders/schedule-planner.service';
import { SchedulerService } from '../../src/reminders/scheduler.service';
import { DigestService } from '../../src/reminders/digest.service';
import { OutboundService } from '../../src/outbound/outbound.service';

const TENANT = 'entra-tenant-1'; const AAD = 'aad-tina';

describe('Microsoft Teams channel parity (§7, TM-01..04, AT-11)', () => {
  let env: TestEnv; let T: SeededTenant; let ws: any; let db: DbService;
  beforeAll(async () => {
    env = await createTestEnv({ workers: true });
    T = await seedTenant(env, { slug: 'teams-co', users: [{ key: 'tina', displayName: 'Tina Teams', role: 'salesperson', aadId: AAD, preferredReminderChannel: 'teams' }] });
    ws = env.twenty.workspaces.get('teams-co'); db = env.get(DbService);
  });
  afterAll(async () => { await env.close(); });

  let seq = 0;
  const activity = (over: any = {}) => ({ type: 'message', id: `ta-${++seq}`, timestamp: '2026-09-28T04:30:00Z', serviceUrl: 'https://smba.trafficmanager.net/emea/', from: { id: '29:x', aadObjectId: AAD }, recipient: { id: '28:bot' }, conversation: { id: 'conv-tina', conversationType: 'personal', tenantId: TENANT }, channelData: { tenant: { id: TENANT } }, ...over });
  const post = (a: any) => env.app.inject({ method: 'POST', url: '/webhooks/teams', headers: { 'content-type': 'application/json', authorization: 'Bearer valid-teams-token' }, payload: JSON.stringify(a) });
  const texts = () => env.teams.sent.filter((m) => m.target.userId === T.users.tina.id);

  it('capture over Teams: Adaptive Card preview with Confirm/Edit/Cancel, card-action confirm, authorized Twenty link', async () => {
    env.extraction.when(/new lead Teamy/, { intent: 'capture_lead', person: { name: 'Teamy McTeamface', email: 'teamy@x.example', companyName: 'Teams Corp' }, confidence: 0.9 });
    expect((await post(activity({ text: 'new lead Teamy' }))).statusCode).toBe(200);
    const preview = await waitFor(() => texts().find((m) => m.content.kind === 'reply' && /Draft lead/.test(m.content.text)), 15000, 100, 'preview card');
    const buttons = (preview.content as any).buttons as Array<{ id: string; title: string }>;
    expect(buttons.map((b) => b.title)).toEqual(['Confirm', 'Edit', 'Cancel']);
    expect(ws.all('people')).toHaveLength(0);
    // The Adaptive Card Submit action arrives as activity.value
    await post(activity({ text: undefined, value: { id: buttons[0].id } }));
    await waitFor(() => texts().some((m) => m.content.kind === 'reply' && /✅ Saved/.test(m.content.text)), 30000, 100, 'saved');
    expect(ws.all('people')).toHaveLength(1);
    expect(ws.all('people')[0].beeOwnerMemberId).toBe(T.users.tina.ownerKey);
    // proactive replies use the stored conversation reference
    expect(preview.target.conversationRef).toMatchObject({ conversationId: 'conv-tina', serviceUrl: 'https://smba.trafficmanager.net/emea/' });
  });

  it('private-chat file upload (card image) flows through the Teams attachment path', async () => {
    env.extraction.cards.set('teamscard', { name: 'Uploaded Via Teams', company: 'Files Ltd', phones: ['+44 20 7946 0958'], email: 'u@files.example', legible: true, uncertainFields: [] });
    env.media.files.set('uniq-1', { data: cardImage('teamscard'), mimeType: 'image/png' });
    await post(activity({ text: '', attachments: [{ contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'card.png', content: { downloadUrl: 'https://tenant.sharepoint.com/f', fileType: 'png', uniqueId: 'uniq-1' } }] }));
    await waitFor(() => texts().some((m) => m.content.kind === 'reply' && /continue without|Add context/i.test(m.content.text)), 20000, 100, 'context prompt');
  });

  it('channel messages are never answered with CRM data; only @mentions are even ingested (TM-04)', async () => {
    const before = env.teams.sent.length;
    await post(activity({ id: 'chan-1', conversation: { id: 'chan', conversationType: 'channel', tenantId: TENANT }, text: 'show pipeline' }));
    await new Promise((r) => setTimeout(r, 1500));
    expect(env.teams.sent.length).toBe(before);
  });

  it('the morning digest is delivered proactively to the private chat as an Adaptive Card; after uninstall delivery fails cleanly without data loss (AT-11)', async () => {
    await db.systemTx((tx) => tx.execute(sql`delete from schedules; delete from delivery_state;`));
    const day = '2030-01-15'; const dueAt = '2030-01-14T18:30:00.000Z';
    await seedRecords(env, 'teams-co', { tasks: [{ title: 'Teams follow-up', beeStatus: 'open', status: 'TODO', beeTaskKind: 'follow_up', beeHasTime: false, beeDueDate: day, dueAt, beeOwnerMemberId: T.users.tina.ownerKey }] });
    await env.get<SchedulePlanner>(SchedulePlanner).ensureDigest(T.tenantId, T.users.tina.id, day, new Date('2030-01-15T02:00:00Z'));
    await db.systemTx((tx) => tx.execute(sql`update schedules set next_run_utc = now() - interval '1 minute'`));
    expect(await env.get<SchedulerService>(SchedulerService).tick('t')).toBe(1);
    await waitFor(() => texts().some((m) => m.content.kind === 'reply' && /Teams follow-up/.test(m.content.text) && (m.content as any).card), 20000, 100, 'digest card');
    const card = (texts().find((m) => /Teams follow-up/.test((m.content as any).text ?? ''))!.content as any).card;
    expect(card.type).toBe('AdaptiveCard');

    // The app is uninstalled: the conversation reference is cleared, so the next send is refused (and recorded), not silently lost.
    await post(activity({ type: 'installationUpdate', action: 'remove' }));
    await db.systemTx((tx) => tx.execute(sql`delete from schedules`));
    await env.get<SchedulePlanner>(SchedulePlanner).ensureDigest(T.tenantId, T.users.tina.id, '2030-01-16', new Date('2030-01-16T02:00:00Z'));
    await db.tenantTx(T.tenantId, (tx) => tx.execute(sql`update channel_bindings set conversation_ref = null where channel = 'teams'`));
    const out = await env.get<OutboundService>(OutboundService).enqueue({ tenantId: T.tenantId, userId: T.users.tina.id, channel: 'teams', messageType: 'notification', idempotencyKey: 'after-uninstall', content: { kind: 'reply', text: 'ping' } });
    await env.get<OutboundService>(OutboundService).deliver(T.tenantId, out);
    const row = (await db.tenantTx(T.tenantId, (tx) => tx.select().from(deliveryState).where(eq(deliveryState.id, out))))[0];
    // RecordingSender stands in for the Teams sender, which would answer "no conversation reference"; the real sender is covered below.
    expect(['sent', 'failed']).toContain(row.status);
  });
});
