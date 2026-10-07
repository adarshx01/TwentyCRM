import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../helpers/app';
import { seedRecords, seedTenant, type SeededTenant } from '../helpers/fixtures';
import { ReportsService } from '../../src/reports/reports.service';
import { ConversationService } from '../../src/conversation/conversation.service';
import { IdentityService } from '../../src/identity/identity.service';
import { DbService } from '../../src/database/db.service';
import { stageHistory } from '../../src/database/schema';
import { CRM_ADAPTER, type CrmAdapter } from '../../src/crm/crm-adapter.interface';
import { ReconciliationService } from '../../src/crm/reconciliation.service';
import { eq } from 'drizzle-orm';

const NOW = new Date('2026-09-28T06:00:00Z');

describe('scoped reports and pipeline totals (SUM-01..03, AT-12, SYNC-03)', () => {
  let env: TestEnv; let T: SeededTenant; let reports: ReportsService; let ws: any; let db: DbService;
  const live = async (k: string) => (await env.get<IdentityService>(IdentityService).getActiveUser(T.tenantId, T.users[k].id))!;

  beforeAll(async () => {
    env = await createTestEnv();
    T = await seedTenant(env, { slug: 'report-co', users: [
      { key: 'sam', displayName: 'Sam', role: 'salesperson', phone: '+919800000001', teamId: 'team-a' },
      { key: 'meera', displayName: 'Meera', role: 'salesperson', phone: '+919800000002', teamId: 'team-b' },
      { key: 'mgr', displayName: 'Maya', role: 'manager', phone: '+919800000003', teamId: 'team-a', managedTeamIds: ['team-a'] },
      { key: 'cxo', displayName: 'Chris', role: 'cxo', phone: '+919800000004' },
    ] });
    reports = env.get(ReportsService); db = env.get(DbService);
    // Known fixture: Sam has 130 open opportunities (> 2 pages of 60): 100 INR @ 1,000 and 30 USD @ 2,000, spread over stages.
    const own = (k: string, team: string) => ({ beeOwnerMemberId: T.users[k].memberId, beeTeamId: team });
    const opps: any[] = [];
    const stages = ['NEW', 'QUALIFIED', 'MEETING', 'PROPOSAL'];
    for (let i = 0; i < 100; i++) opps.push({ name: `Sam INR ${i}`, stage: stages[i % 4], amount: { amountMicros: 1_000_000_000, currencyCode: 'INR' }, ...own('sam', 'team-a') });
    for (let i = 0; i < 30; i++) opps.push({ name: `Sam USD ${i}`, stage: stages[i % 4], amount: { amountMicros: 2_000_000_000, currencyCode: 'USD' }, ...own('sam', 'team-a') });
    opps.push({ name: 'Sam archived', stage: 'NEW', amount: { amountMicros: 999_000_000_000, currencyCode: 'INR' }, beeArchived: true, ...own('sam', 'team-a') });
    opps.push({ name: 'Sam no value', stage: 'NEW', ...own('sam', 'team-a') });
    opps.push({ name: 'Sam lost', stage: 'LOST', amount: { amountMicros: 7_000_000_000, currencyCode: 'INR' }, ...own('sam', 'team-a') });
    for (let i = 0; i < 20; i++) opps.push({ name: `Meera ${i}`, stage: 'NEGOTIATION', amount: { amountMicros: 5_000_000_000, currencyCode: 'INR' }, ...own('meera', 'team-b') });
    // Won deals
    opps.push({ id: 'won-this-month-1', name: 'Won A', stage: 'WON', amount: { amountMicros: 10_000_000_000, currencyCode: 'INR' }, ...own('sam', 'team-a') });
    opps.push({ id: 'won-this-month-2', name: 'Won B', stage: 'WON', amount: { amountMicros: 3_000_000_000, currencyCode: 'USD' }, ...own('sam', 'team-a') });
    opps.push({ id: 'won-last-month', name: 'Won C', stage: 'WON', amount: { amountMicros: 50_000_000_000, currencyCode: 'INR' }, ...own('sam', 'team-a') });
    opps.push({ id: 'won-imported', name: 'Won imported', stage: 'WON', amount: { amountMicros: 1_000_000_000, currencyCode: 'INR' }, ...own('sam', 'team-a') });
    opps.push({ id: 'won-meera', name: 'Meera won', stage: 'WON', amount: { amountMicros: 4_000_000_000, currencyCode: 'INR' }, ...own('meera', 'team-b') });
    ws = await seedRecords(env, 'report-co', { opportunities: opps });
    const h = (id: string, at: string) => db.tenantTx(T.tenantId, (tx) => tx.insert(stageHistory).values({ tenantId: T.tenantId, opportunityId: id, toStageId: 'won', terminalType: 'won', changedAt: new Date(at), source: 'chat' }));
    await h('won-this-month-1', '2026-09-03T05:00:00Z'); await h('won-this-month-2', '2026-09-20T05:00:00Z'); await h('won-last-month', '2026-08-30T20:00:00Z'); await h('won-meera', '2026-09-10T05:00:00Z');
  });
  afterAll(async () => { await env.close(); });

  const run = async (type: any, k: string, target?: string) => { const l = await live(k); return (await reports.run(type, l.tenant, l.user, { now: NOW, target })).text; };

  it('personal pipeline: paginates every page, counts only open non-archived, sums per currency without mixing (AT-12)', async () => {
    const t = await run('my_pipeline', 'sam');
    expect(t).toContain('Open opportunities: 131'); // 100 INR + 30 USD + 1 without a value; archived/lost/won excluded
    expect(t).toContain('100,000 INR + 60,000 USD');
    expect(t).toMatch(/New: \d+/);
    expect(t).toContain('1 open opportunities have no amount');
    expect(t).not.toContain('999'); // archived value never appears
    expect(t).toContain('Asia/Kolkata'); expect(t).toMatch(/Retrieved/); expect(t).toContain('your records');
    expect(ws.calls.filter((c: any) => c.path === '/rest/opportunities' && c.method === 'GET').length).toBeGreaterThanOrEqual(3); // really paged
  });

  it('salesperson scope is personal; manager scope is the managed team; CXO scope is the client (SUM-01)', async () => {
    const mgr = await run('team_pipeline', 'mgr');
    expect(mgr).toContain("team's pipeline"); expect(mgr).toContain('100,000 INR'); expect(mgr).not.toContain('Negotiation: 20'); // Meera is in team-b
    const cxo = await run('team_pipeline', 'cxo');
    expect(cxo).toContain('Negotiation: 20'); expect(cxo).toContain('200,000 INR'); expect(cxo).toContain('all records in this workspace');
    const meera = await run('my_pipeline', 'meera');
    expect(meera).toContain('Open opportunities: 20'); expect(meera).not.toContain('USD');
  });

  it('won this month uses the recorded stage-change date, groups currencies, and discloses missing history (SUM-03)', async () => {
    const t = await run('won_this_month', 'sam');
    expect(t).toContain('Won: 2');
    expect(t).toContain('10,000 INR + 3,000 USD');
    expect(t).toContain('Won A'); expect(t).toContain('Won B');
    expect(t).not.toContain('Won C'); // won last month by stage-change date even if modified recently
    expect(t).not.toContain('Meera won');
    expect(t).toMatch(/1 won opportunities have no recorded stage-change date/); // the imported record
  });

  it('the CXO sees the client-wide figure', async () => {
    const t = await run('won_this_month', 'cxo');
    expect(t).toContain('Won: 3'); expect(t).toContain('14,000 INR + 3,000 USD');
  });

  it('returns "no matching records" instead of inventing an explanation', async () => {
    const t = await run('company_summary', 'sam', 'Nonexistent Corp');
    expect(t).toContain('No matching records');
    expect(await run('today_meetings', 'sam')).toContain('No matching records');
    expect(await run('overdue_followups', 'sam')).toContain('No matching records');
  });

  it('truncation is disclosed when the fetch cap is reached', async () => {
    const crm = env.get<CrmAdapter>(CRM_ADAPTER);
    const l = await live('cxo');
    const r = await crm.listOpportunities(l.tenant, { scope: { kind: 'all' }, maxRecords: 61 });
    expect(r.truncated).toBe(true); expect(r.items.length).toBeLessThanOrEqual(120);
    const full = await crm.listOpportunities(l.tenant, { scope: { kind: 'all' } });
    expect(full.truncated).toBe(false); expect(full.total).toBe(ws.all('opportunities').length);
  });

  it('SYNC-03: reconciliation records stage transitions made in the Twenty UI with their timestamps', async () => {
    const recon = env.get(ReconciliationService);
    await recon.run(T.tenantId, NOW); // baseline index
    const opp = ws.all('opportunities').find((o: any) => o.name === 'Meera 0');
    opp.stage = 'WON'; opp.updatedAt = '2026-09-28T06:30:00.000Z'; // edited in the Twenty UI after the last sync
    const r = await recon.run(T.tenantId, NOW);
    expect(r.stageChanges).toBe(1);
    const rows = await db.tenantTx(T.tenantId, (tx) => tx.select().from(stageHistory).where(eq(stageHistory.opportunityId, opp.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromStageId: 'negotiation', toStageId: 'won', terminalType: 'won', source: 'reconciliation' });
    expect(rows[0].changedAt.toISOString()).toBe('2026-09-28T06:30:00.000Z');
    expect((await recon.run(T.tenantId, NOW)).stageChanges).toBe(0); // idempotent
  });

  it('company summary is scoped: stages, next actions and only the caller\'s notes (no cross-owner relation leak)', async () => {
    const comp = crypto.randomUUID(); const person = crypto.randomUUID(); const oppA = crypto.randomUUID(); const oppB = crypto.randomUUID();
    const noteA = crypto.randomUUID(); const noteB = crypto.randomUUID();
    await seedRecords(env, 'report-co', {
      companies: [{ id: comp, name: 'Shared Corp', beeOwnerMemberId: T.users.cxo.memberId }],
      opportunities: [{ id: oppA, name: 'Shared deal A', stage: 'PROPOSAL', companyId: comp, amount: { amountMicros: 2_000_000_000, currencyCode: 'INR' }, beeOwnerMemberId: T.users.sam.memberId, beeTeamId: 'team-a' }, { id: oppB, name: 'Shared deal B', stage: 'MEETING', companyId: comp, beeOwnerMemberId: T.users.meera.memberId, beeTeamId: 'team-b' }],
      notes: [{ id: noteA, title: 'a', bodyV2: { markdown: 'Sam private note' }, beeOwnerMemberId: T.users.sam.memberId }, { id: noteB, title: 'b', bodyV2: { markdown: 'Meera private note' }, beeOwnerMemberId: T.users.meera.memberId }],
      noteTargets: [{ noteId: noteA, targetCompanyId: comp }, { noteId: noteB, targetCompanyId: comp }],
    });
    // Sam can see the company only if it is in his scope: it is owned by the CXO, so Sam gets nothing — and no leak.
    expect(await run('company_summary', 'sam', 'Shared Corp')).toContain('No matching records');
    const cxo = await run('company_summary', 'cxo', 'Shared Corp');
    expect(cxo).toContain('Open opportunities: 2'); expect(cxo).toContain('Sam private note'); expect(cxo).toContain('Meera private note');
    // owning the company but not the sibling records: only own opportunities and notes
    await ws.all('companies').find((c: any) => c.id === comp) && (ws.all('companies').find((c: any) => c.id === comp).beeOwnerMemberId = T.users.sam.memberId);
    const sam = await run('company_summary', 'sam', 'Shared Corp');
    expect(sam).toContain('Open opportunities: 1'); expect(sam).toContain('Sam private note'); expect(sam).not.toContain('Meera private note'); expect(sam).not.toContain('Shared deal B');
  });
});
void ConversationService;
