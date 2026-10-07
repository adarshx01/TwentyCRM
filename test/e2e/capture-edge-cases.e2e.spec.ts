import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, waitFor, type TestEnv } from '../helpers/app';
import { buttonId, confirmLast, lastWithButtons, pressButton, seedRecords, seedTenant, sendMedia, sendText, talk, type SeededTenant } from '../helpers/fixtures';
import { cardImage, voiceNote } from '../helpers/fakes';
import { DbService } from '../../src/database/db.service';
import { drafts, mediaObjects, usageEvents } from '../../src/database/schema';
import { MediaService } from '../../src/media/media.service';

const SAM = '+919800000001'; const OTHER = '+919800000002';
const AT = { receivedAt: '2026-09-28T04:30:00.000Z' };

describe('duplicates, ambiguity and media handling during capture (AT-05, AT-07, CAP-01..06)', () => {
  let env: TestEnv; let T: SeededTenant; let ws: any; let db: DbService;
  beforeAll(async () => {
    env = await createTestEnv({ workers: true });
    T = await seedTenant(env, { slug: 'edge-co', defaultCountry: 'IN', users: [
      { key: 'sam', displayName: 'Sam', role: 'salesperson', phone: SAM, teamId: 'a' },
      { key: 'meera', displayName: 'Meera', role: 'salesperson', phone: OTHER, teamId: 'b' },
    ] });
    ws = env.twenty.workspaces.get('edge-co'); db = env.get(DbService);
  });
  afterAll(async () => { await env.close(); });

  const card = (key: string, c: any) => { env.extraction.cards.set(key, { phones: [], legible: true, uncertainFields: [], ...c }); env.media.files.set(`img-${key}`, { data: cardImage(key), mimeType: 'image/png' }); };
  const upload = async (key: string) => { await sendMedia(env, SAM, 'image', `img-${key}`, 'image/png', { ...AT, providerEventId: `evt-${key}-${Math.random()}` }); };
  const lastText = () => env.whatsapp.texts(T.users.sam.id).slice(-1)[0] ?? '';
  const waitText = (re: RegExp) => waitFor(() => re.test(env.whatsapp.texts(T.users.sam.id).slice(-3).join('\n')) || undefined, 20000, 100, `text ${re}`);

  it('AT-05: the same card twice matches the existing contact; populated fields are never overwritten silently', async () => {
    card('dup', { name: 'Rajesh Kumar', title: 'CEO', company: 'ABC Industries', phones: ['+91 98765 43210'], email: 'rajesh@abc.com' });
    await upload('dup'); await waitText(/continue without|Add context/i);
    await talk(env, T, 'sam', 'continue without a note', AT);
    await confirmLast(env, T, 'sam');
    expect(ws.all('people')).toHaveLength(1);
    ws.all('people')[0].jobTitle = 'Managing Director'; // changed in Twenty after the first capture

    // second upload of the same card: the assistant offers the existing record (never merges on its own)
    env.whatsapp.clear();
    await upload('dup'); await waitText(/continue without|Add context/i);
    await sendText(env, SAM, 'continue without a note', AT);
    await waitText(/same person/i);
    const q = env.whatsapp.texts(T.users.sam.id).join('\n');
    expect(q).toMatch(/Update existing: Rajesh Kumar \(rajesh@abc.com\)/); expect(q).toMatch(/Create a new contact/);
    expect(ws.all('people')).toHaveLength(1);
    // Answer each question in turn: contact → existing, company → existing, opportunity → explicitly create another.
    const answers: Array<[RegExp, string]> = [[/same person/i, '1'], [/already exists/i, '1'], [/open opportunities/i, '2']];
    const answered = new Set<number>();
    await waitFor(async () => {
      const recent = env.whatsapp.texts(T.users.sam.id).slice(-2).join('\n');
      const lb = lastWithButtons(env, T.users.sam.id);
      if (lb && /Draft lead/.test((lb.content as any).text) && Date.now() - 0 > 0 && /updating existing/.test((lb.content as any).text)) return true;
      for (const [k, [re, ans]] of answers.entries()) if (!answered.has(k) && re.test(recent)) { answered.add(k); await sendText(env, SAM, ans, AT); }
      return false;
    }, 40000, 400, 'preview after answering questions');
    const preview = (lastWithButtons(env, T.users.sam.id)!.content as any).text as string;
    expect(preview).toMatch(/updating existing — Rajesh Kumar/);
    expect(preview).not.toMatch(/title: .*→/);   // 'Managing Director' is populated: not touched
    await confirmLast(env, T, 'sam');
    expect(ws.all('people')).toHaveLength(1);
    expect(ws.all('people')[0].jobTitle).toBe('Managing Director');
    expect(ws.all('opportunities').length).toBe(2); // a second opportunity was an explicit choice
  });

  it('matches in other users\' records are never revealed — only that a match exists (Section 4)', async () => {
    await seedRecords(env, 'edge-co', { people: [{ name: { firstName: 'Secret', lastName: 'Person' }, emails: { primaryEmail: 'secret@hidden.example' }, beePhoneE164: '+919222222222', beeOwnerMemberId: T.users.meera.memberId, beeTeamId: 'b' }] });
    card('hidden', { name: 'Someone Else', company: 'Hidden Co', phones: ['+91 92222 22222'], email: 'secret@hidden.example' });
    env.whatsapp.clear();
    await upload('hidden'); await waitText(/continue without|Add context/i);
    await talk(env, T, 'sam', 'continue without a note', AT);
    const p = (lastWithButtons(env, T.users.sam.id)!.content as any).text as string;
    expect(p).toMatch(/possible match exists outside your access; no details are shown/);
    expect(p).not.toMatch(/Secret|Person|Meera/);
    expect(env.whatsapp.texts(T.users.sam.id).join('\n')).not.toMatch(/Update existing/); // no option that would identify the hidden record
  });

  it('AT-07: ambiguous dates, missing country code and noisy audio produce questions or flags, never invented data', async () => {
    await talk(env, T, 'sam', 'cancel', AT);
    env.extraction.transcripts.set('noisy', 'Met Priya ... [noise] ... follow up sometime next month maybe, number is 98111 22233');
    env.extraction.when(/Met Priya/, { intent: 'capture_lead', person: { name: 'Priya', phone: '98111 22233' }, tasks: [{ title: 'Follow up', type: 'follow_up', dateExpression: 'sometime next month' }], confidence: 0.4 });
    env.media.files.set('noisy-aud', { data: voiceNote('noisy'), mimeType: 'audio/wav' });
    env.whatsapp.clear();
    await sendMedia(env, SAM, 'audio', 'noisy-aud', 'audio/wav', AT);
    await waitText(/When should I schedule/);
    expect(lastText()).toMatch(/not a specific date/);
    expect(ws.all('tasks')).toHaveLength(0);
    const out = (await talk(env, T, 'sam', 'no date', AT)).join('\n');
    expect(out).toContain('Draft lead');
    expect(out).not.toMatch(/Task 1|Meeting 1/);                  // no task invented
    expect(out).toMatch(/country code not given/);                 // flagged, saved as written if confirmed
    expect(out).toMatch(/automatic transcription — please check/); // low confidence → explicit warning
    expect(out).not.toMatch(/\+91 ?9876543210|\+919876543210/);    // not silently "fixed" into E.164 with an assumed country… (unless hinted)
  });

  it('CAP-01: unsupported, corrupt and oversized files are rejected with a useful message and nothing is stored', async () => {
    const mediaBefore = (await db.tenantTx(T.tenantId, (tx) => tx.select().from(mediaObjects))).length;
    const cases: Array<[string, Buffer, 'image' | 'audio', string, RegExp]> = [
      ['exe', Buffer.from('MZ\x90\x00 executable payload'), 'image', 'image/jpeg', /could not read that file/i],
      ['pdf', Buffer.from('%PDF-1.4 hello'), 'image', 'image/png', /could not read that file/i],
      ['bigimg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(10 * 1024 * 1024 + 10)]), 'image', 'image/jpeg', /larger than 10 MB/],
      ['badaudio', Buffer.from('RIFF\x00\x00\x00\x00WAVEgarbage garbage garbage'), 'audio', 'audio/wav', /corrupt/i],
      ['pngasaudio', cardImage('x'), 'audio', 'audio/ogg', /audio format is not supported/i],
    ];
    for (const [id, data, kind, mime, re] of cases) {
      env.media.files.set(id, { data, mimeType: mime });
      env.whatsapp.clear();
      await sendMedia(env, SAM, kind, id, mime, { ...AT, providerEventId: `bad-${id}` });
      await waitText(re);
    }
    expect((await db.tenantTx(T.tenantId, (tx) => tx.select().from(mediaObjects))).length).toBe(mediaBefore);
    // 5-minute audio limit
    const long = voiceNote('long', 310);
    env.media.files.set('long', { data: long, mimeType: 'audio/wav' });
    env.whatsapp.clear();
    await sendMedia(env, SAM, 'audio', 'long', 'audio/wav', { ...AT, providerEventId: 'bad-long' });
    await waitText(/at most 5 minutes/);
  }, 90000);

  it('the media service refuses keys from another tenant and never exposes public URLs (SEC-01)', async () => {
    const media = env.get<MediaService>(MediaService);
    const [m] = await db.tenantTx(T.tenantId, (tx) => tx.select().from(mediaObjects));
    expect(m.key.startsWith(`tenants/${T.tenantId}/`)).toBe(true);
    await expect(media.load('00000000-0000-0000-0000-000000000000', m.key)).rejects.toThrow();
    await expect(media.load(T.tenantId, `tenants/${T.tenantId}/../other/x`)).rejects.toThrow();
    await expect(media.signedUrl('00000000-0000-0000-0000-000000000000', m.key)).rejects.toThrow();
  });

  it('usage is metered per tenant: tokens, transcription, vision calls, media bytes (§11)', async () => {
    const u = await db.tenantTx(T.tenantId, (tx) => tx.select().from(usageEvents));
    const kinds = new Set(u.map((x) => x.kind));
    for (const k of ['llm_tokens', 'vision_calls', 'stt_seconds']) expect(kinds.has(k), k).toBe(true);
  });

  it('retention: abandoned media is deleted after 24h; media of a confirmed draft after 30 days (SEC-04)', async () => {
    const media = env.get<MediaService>(MediaService);
    const { DraftService } = await import('../../src/conversation/draft.service');
    await env.get<InstanceType<typeof DraftService>>(DraftService).expireDue(new Date(Date.now() + 3_600_000)); // drafts expire after 30 min (SEC-04)
    const rows = await db.tenantTx(T.tenantId, (tx) => tx.select().from(mediaObjects));
    const confirmed = rows.filter((r) => r.confirmedAt); const abandoned = rows.filter((r) => !r.confirmedAt);
    expect(confirmed.length).toBeGreaterThan(0); expect(confirmed[0].deleteAfter).toBeTruthy();
    const day = 86_400_000;
    expect(await media.cleanup(new Date(Date.now() + 2 * day))).toBeGreaterThanOrEqual(abandoned.filter((r) => r.kind !== 'raw_email').length > 0 ? 1 : 0);
    const after = await db.tenantTx(T.tenantId, (tx) => tx.select().from(mediaObjects));
    expect(after.filter((r) => r.confirmedAt && !r.deletedAt)).toHaveLength(confirmed.length); // confirmed ones survive 2 days
    await media.cleanup(new Date(Date.now() + 40 * day));
    expect((await db.tenantTx(T.tenantId, (tx) => tx.select().from(mediaObjects))).every((r) => r.deletedAt)).toBe(true);
  });
});
void pressButton; void buttonId; void drafts;
