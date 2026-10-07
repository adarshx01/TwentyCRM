import { describe, expect, it } from 'vitest';
import { applyCard, applyEdit, applyIntent, answerClarification, answerTaskClarification, buildCaptureAction, nextStep, parseEdit, type CaptureEnv } from '../../src/conversation/capture-logic';
import { emptyCapture } from '../../src/conversation/draft.types';
import type { LlmIntent } from '../../src/common/schemas';
import type { NormalizedCard } from '../../src/extraction/extraction.service';

const env: CaptureEnv = { timezone: 'Asia/Kolkata', nowIso: '2026-09-28T04:30:00.000Z', defaultCountry: 'IN', defaultCurrency: 'INR', stageLabel: (s) => s };
const card = (o: Partial<NormalizedCard> = {}): NormalizedCard => ({ name: 'Rajesh Kumar', title: 'CEO', company: 'ABC Industries', phones: [{ raw: '+91 98765 43210', e164: '+919876543210', country: 'IN', countryAssumed: false }], email: 'rajesh@abc.com', website: 'abc.com', legible: true, uncertain: [], ...o });
const voice: LlmIntent = { intent: 'capture_lead', person: { name: 'Rajesh', companyName: 'ABC Industries' }, interest: 'demand forecasting', tasks: [{ title: 'Meeting with Rajesh', type: 'meeting', dateExpression: '29 September', timeExpression: '11 AM' }] };

describe('card + voice capture (AT-03, CAP-03..05)', () => {
  it('merges card and voice into one draft with a resolved absolute meeting time', () => {
    const d = emptyCapture('new'); d.awaitingContext = true; d.pending.card = 1;
    applyCard(d, card(), env);
    applyIntent(d, voice, 'Met Rajesh from ABC Industries. Interested in demand forecasting. Meet him on 29 September at 11 AM.', 'voice', env);
    expect(nextStep(d).kind).toBe('ready');
    expect(d.person).toMatchObject({ name: 'Rajesh Kumar', phoneE164: '+919876543210', email: 'rajesh@abc.com' });
    expect(d.fieldSources).toMatchObject({ name: 'card', email: 'card', phone: 'card', interest: 'voice' });
    expect(d.tasks[0]).toMatchObject({ type: 'meeting', dueDate: '2026-09-29', dueTime: '11:00', timezone: 'Asia/Kolkata' });
    expect(d.notes[0]).toMatchObject({ type: 'transcript', source: 'voice' });
    const a = buildCaptureAction(d);
    expect(a.person).toMatchObject({ name: 'Rajesh Kumar', phoneE164: '+919876543210' });
    expect(a.company?.name).toBe('ABC Industries');
    expect(a.tasks).toHaveLength(1);
    expect(a.opportunity?.title).toBe('Rajesh Kumar — ABC Industries');
  });
  it('card details are never silently replaced by voice details; the conflict is flagged', () => {
    const d = emptyCapture('new');
    applyCard(d, card(), env);
    applyIntent(d, { intent: 'capture_lead', person: { name: 'Rajesh Kumar', phone: '+91 91111 22222' } }, 'x', 'voice', env);
    expect(d.person!.phoneE164).toBe('+919876543210');
    expect(d.uncertain.some((u) => u.field === 'phone' && /conflict/.test(u.reason))).toBe(true);
  });
  it('a card-only draft asks for context before previewing (CAP-02)', () => {
    const d = emptyCapture('new'); d.awaitingContext = true;
    applyCard(d, card(), env);
    expect(nextStep(d).kind).toBe('need_context');
    applyEdit(d, parseEdit('continue without a note')!, env, () => undefined);
    expect(nextStep(d).kind).toBe('ready');
  });
  it('pending AI work keeps the draft in the processing state', () => {
    const d = emptyCapture('new'); d.pending.voice = 1;
    expect(nextStep(d).kind).toBe('processing');
  });
  it('a missing country code is flagged, never silently trusted (CAP-04)', () => {
    const d = emptyCapture('new');
    applyCard(d, card({ phones: [{ raw: '98765 43210', e164: '+919876543210', country: 'IN', countryAssumed: true }] }), env);
    expect(d.uncertain.some((u) => u.field === 'phone' && /country code/.test(u.reason))).toBe(true);
  });
  it('no target person or company → asks who the lead is', () => {
    const d = emptyCapture('new');
    applyIntent(d, { intent: 'capture_lead', interest: 'ERP' }, 'interested in ERP', 'text', env);
    const s = nextStep(d);
    expect(s.kind).toBe('clarify');
    if (s.kind === 'clarify') expect(s.clarification.kind).toBe('person_unclear');
  });
});

describe('dates and tasks need explicit answers (AT-07)', () => {
  it('vague follow-up asks for a date and creates nothing meanwhile', () => {
    const d = emptyCapture('new');
    applyIntent(d, { intent: 'capture_lead', person: { name: 'Meera' }, tasks: [{ title: 'Follow up', type: 'follow_up', dateExpression: 'sometime next month' }] }, 'follow up sometime next month', 'text', env);
    expect(nextStep(d).kind).toBe('clarify');
    expect(d.tasks[0].dueDate).toBeUndefined();
    expect(answerTaskClarification(d, 'soon', env).ok).toBe(false);
    expect(answerTaskClarification(d, 'no date', env).ok).toBe(true);
    expect(d.tasks).toHaveLength(0);
    expect(nextStep(d).kind).toBe('ready');
  });
  it('a meeting without a time asks for the time, or can be downgraded to a date-only follow-up', () => {
    const d = emptyCapture('new');
    applyIntent(d, { intent: 'capture_lead', person: { name: 'Meera' }, tasks: [{ title: 'Meet Meera', type: 'meeting', dateExpression: 'next Tuesday' }] }, 'meet next Tuesday', 'text', env);
    expect(d.clarifications[0].kind).toBe('meeting_time');
    expect(answerTaskClarification(d, 'maybe afternoon', env).ok).toBe(false);
    expect(answerTaskClarification(d, 'date only', env).ok).toBe(true);
    expect(d.tasks[0]).toMatchObject({ type: 'follow_up', dueDate: '2026-10-06' });
    expect(d.tasks[0].dueTime).toBeUndefined();
  });
  it('relative dates are anchored to the message timestamp', () => {
    const d = emptyCapture('new');
    applyIntent(d, { intent: 'create_task', person: { name: 'X' }, tasks: [{ title: 'Call', type: 'call', dateExpression: 'tomorrow', timeExpression: '3 PM' }] }, 'call tomorrow 3 PM', 'text', { ...env, nowIso: '2026-12-31T10:00:00Z' });
    expect(d.tasks[0]).toMatchObject({ dueDate: '2027-01-01', dueTime: '15:00' });
  });
});

describe('edits and existing-record decisions (CAP-06, ACT-02)', () => {
  it('parses the edit grammar', () => {
    expect(parseEdit('phone +91 90000 11111')).toEqual({ op: 'set', field: 'phone', value: '+91 90000 11111' });
    expect(parseEdit('Change email to a@b.com')).toEqual({ op: 'set', field: 'email', value: 'a@b.com' });
    expect(parseEdit('stage Proposal')).toEqual({ op: 'set', field: 'stage', value: 'Proposal' });
    expect(parseEdit('note: asked for a quote')).toEqual({ op: 'note', value: 'asked for a quote' });
    expect(parseEdit('replace phone')).toEqual({ op: 'replace', field: 'phone' });
    expect(parseEdit('remove task 2')).toEqual({ op: 'remove_task', index: 1 });
    expect(parseEdit('what is the weather')).toBeNull();
  });
  it('a corrected phone is normalized and wins over the card (user edits are authoritative)', () => {
    const d = emptyCapture('new'); applyCard(d, card(), env);
    expect(applyEdit(d, parseEdit('phone +91 90000 11111')!, env, () => undefined).ok).toBe(true);
    expect(d.person).toMatchObject({ phoneE164: '+919000011111', phoneRaw: '+91 90000 11111' });
    expect(d.fieldSources.phone).toBe('user');
  });
  it('rejects an invalid email and an unknown stage with a clear message', () => {
    const d = emptyCapture('new');
    expect(applyEdit(d, { op: 'set', field: 'email', value: 'nope' }, env, () => undefined)).toMatchObject({ ok: false });
    expect(applyEdit(d, { op: 'set', field: 'stage', value: 'Imaginary' }, env, () => undefined)).toMatchObject({ ok: false });
  });
  it('updating an existing contact fills only blanks and never overwrites silently', () => {
    const d = emptyCapture('new'); applyCard(d, card(), env);
    d.matches.people = [{ id: 'p-1', label: 'Rajesh K', updatedAt: 'v1', existing: { email: 'old@abc.com', phone: undefined, title: 'Director' } }];
    d.clarifications = [{ id: 'c', kind: 'match_person', question: '?', options: [{ id: 'p-1', label: 'Update' }, { id: 'new', label: 'New' }] }];
    expect(answerClarification(d, '1').ok).toBe(true);
    let a = buildCaptureAction(d);
    expect(a.existing?.personId).toBe('p-1');
    expect(a.person).toBeUndefined();
    expect(a.personFill).toEqual({ phoneRaw: '+91 98765 43210', phoneE164: '+919876543210' }); // email & title kept
    d.overwrite.push('email');
    a = buildCaptureAction(d);
    expect(a.personFill?.email).toBe('rajesh@abc.com');
    expect(a.personFill?.title).toBeUndefined();
  });
  it('"create new" produces a new person and no link', () => {
    const d = emptyCapture('new'); applyCard(d, card(), env);
    d.matches.people = [{ id: 'p-1', label: 'R', updatedAt: '', existing: {} }];
    d.clarifications = [{ id: 'c', kind: 'match_person', question: '?', options: [{ id: 'p-1', label: 'U' }, { id: 'new', label: 'N' }] }];
    expect(answerClarification(d, '2').ok).toBe(true);
    expect(buildCaptureAction(d).person?.name).toBe('Rajesh Kumar');
    expect(buildCaptureAction(d).existing).toBeUndefined();
  });
  it('invalid numbered answers are rejected', () => {
    const d = emptyCapture('new');
    d.clarifications = [{ id: 'c', kind: 'match_person', question: '?', options: [{ id: 'a', label: 'A' }, { id: 'new', label: 'N' }] }];
    expect(answerClarification(d, '7').ok).toBe(false);
    expect(d.clarifications).toHaveLength(1);
  });
});
