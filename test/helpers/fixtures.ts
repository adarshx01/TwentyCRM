import { createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { TestEnv } from './app';
import { WA_PHONE_ID, WA_SECRET } from './app';
import { DbService } from '../../src/database/db.service';
import { TenantProvisioningService } from '../../src/admin/tenant-provisioning.service';
import { channelBindings, users } from '../../src/database/schema';
import { generateToken } from '../../src/common/guards/auth.guard';
import { JWT_SECRET } from './app';
import type { NormalizedEvent } from '../../src/common/schemas';
import { InboundService } from '../../src/webhooks/inbound.service';

export const STAGES = [
  { id: 'new', label: 'New' }, { id: 'qualified', label: 'Qualified' }, { id: 'meeting', label: 'Meeting' },
  { id: 'proposal', label: 'Proposal' }, { id: 'negotiation', label: 'Negotiation' },
  { id: 'won', label: 'Won', terminal: 'won' as const }, { id: 'lost', label: 'Lost', terminal: 'lost' as const },
];

export interface SeedUser { key: string; displayName: string; role: 'salesperson' | 'manager' | 'cxo' | 'client_admin'; teamId?: string; managedTeamIds?: string[]; phone?: string; aadId?: string; timezone?: string; preferredReminderChannel?: 'whatsapp' | 'teams' }

export interface SeededTenant {
  tenantId: string;
  slug: string;
  token: string;
  /** ownerKey = the stable CRM ownership key (the Bee user id); memberId = the user's linked Twenty workspace member */
  users: Record<string, { id: string; phone?: string; aad?: string; ownerKey: string; memberId: string }>;
}

let tenantSeq = 0;

/** Provision a tenant through the real provisioning service, then bind channel identities. */
export async function seedTenant(env: TestEnv, opts: { slug?: string; users: SeedUser[]; pipelineStages?: typeof STAGES; timezone?: string; extra?: Record<string, unknown>; defaultCountry?: string; connection?: { wa?: string; teamsTenant?: string } }): Promise<SeededTenant> {
  const n = ++tenantSeq;
  const slug = opts.slug ?? `client-${n}-${Math.random().toString(36).slice(2, 6)}`;
  const token = `tok-${slug}`;
  process.env[`TWENTY_TOKEN_${n}_${slug.replace(/-/g, '_')}`] = token;
  const ws = env.twenty.addWorkspace(slug, token);
  for (const u of opts.users) ws.data.workspaceMembers.push({ id: `m-${slug}-${u.key}`, name: { firstName: u.displayName, lastName: '' }, userEmail: `${u.key}@${slug}.test`, userId: `tu-${slug}-${u.key}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const refName = `TWENTY_TOKEN_${n}_${slug.replace(/-/g, '_')}`;
  const manifest = {
    manifestVersion: 1, slug, name: `Client ${slug}`, twenty: { workspaceId: `ws-${slug}`, baseUrl: env.twenty.url, apiTokenRef: `env:${refName}` },
    timezone: opts.timezone ?? 'Asia/Kolkata', workingDays: [1, 2, 3, 4, 5], morningReminderTime: '09:00', defaultCurrency: 'INR', defaultCountry: opts.defaultCountry ?? 'IN',
    pipeline: { stages: opts.pipelineStages ?? STAGES, defaultInitialStage: 'new' },
    users: opts.users.map((u) => ({ displayName: u.displayName, email: `${u.key}@${slug}.test`, role: u.role, twentyMemberId: `m-${slug}-${u.key}`, teamId: u.teamId, managedTeamIds: u.managedTeamIds, timezone: u.timezone, preferredReminderChannel: u.preferredReminderChannel ?? (u.aadId && !u.phone ? 'teams' : 'whatsapp') })),
    ...opts.extra,
  };
  const report = await env.get<TenantProvisioningService>(TenantProvisioningService).provision(manifest);
  const db = env.get<DbService>(DbService);
  const rows = await db.tenantTx(report.tenantId, (tx) => tx.select().from(users).where(eq(users.tenantId, report.tenantId)));
  const out: SeededTenant = { tenantId: report.tenantId, slug, token, users: {} };
  for (const u of opts.users) {
    const row = rows.find((r) => r.email === `${u.key}@${slug}.test`)!;
    out.users[u.key] = { id: row.id, phone: u.phone, aad: u.aadId, ownerKey: row.id, memberId: `m-${slug}-${u.key}` };
    await db.tenantTx(report.tenantId, async (tx) => {
      if (u.phone) await tx.insert(channelBindings).values({ tenantId: report.tenantId, userId: row.id, channel: 'whatsapp', connectionId: opts.connection?.wa ?? WA_PHONE_ID, externalId: u.phone, lastInboundAt: new Date() });
      if (u.aadId) await tx.insert(channelBindings).values({ tenantId: report.tenantId, userId: row.id, channel: 'teams', connectionId: opts.connection?.teamsTenant ?? 'entra-tenant-1', externalId: u.aadId, conversationRef: { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: `conv-${u.key}`, tenantId: opts.connection?.teamsTenant ?? 'entra-tenant-1' } });
    });
  }
  return out;
}

export const jwtFor = (t: SeededTenant, userKey: string) => generateToken({ userId: t.users[userKey].id, tenantId: t.tenantId }, JWT_SECRET, 3600);

let evtSeq = 0;
/** Deliver a normalized WhatsApp-style event through the real inbound pipeline (accept → queue → worker). */
export async function inboundWa(env: TestEnv, phone: string, partial: Partial<NormalizedEvent> & { messageType?: NormalizedEvent['messageType'] }): Promise<NormalizedEvent> {
  const e: NormalizedEvent = {
    providerEventId: partial.providerEventId ?? `wamid.${++evtSeq}.${Math.random().toString(36).slice(2, 8)}`, channel: 'whatsapp', connectionId: partial.connectionId ?? WA_PHONE_ID,
    externalSenderId: phone, conversationId: partial.conversationId ?? `wa:${WA_PHONE_ID}:${phone.replace('+', '')}`, receivedAt: partial.receivedAt ?? new Date().toISOString(), messageType: 'text', ...partial,
  } as NormalizedEvent;
  await env.get<InboundService>(InboundService).accept(e);
  return e;
}

export const waSign = (raw: string) => `sha256=${createHmac('sha256', WA_SECRET).update(raw).digest('hex')}`;
export { and };

export const sendText = (env: TestEnv, phone: string, text: string, extra: Partial<NormalizedEvent> = {}) => inboundWa(env, phone, { messageType: 'text', text, ...extra });
export const sendMedia = (env: TestEnv, phone: string, kind: 'image' | 'audio', mediaId: string, mimeType: string, extra: Partial<NormalizedEvent> = {}) =>
  inboundWa(env, phone, { messageType: kind, media: [{ mediaId, mimeType }], ...extra });
export const pressButton = (env: TestEnv, phone: string, id: string, extra: Partial<NormalizedEvent> = {}) =>
  inboundWa(env, phone, { messageType: 'interactive', interactiveResponse: { type: 'button_reply', id }, ...extra });

/** Latest message (with buttons) that the bot sent to a user on WhatsApp. */
export function lastWithButtons(env: TestEnv, userId: string) {
  const list = env.whatsapp.sent.filter((m) => m.target.userId === userId && m.content.kind === 'reply' && m.content.buttons?.length);
  return list[list.length - 1];
}
export const buttonId = (m: ReturnType<typeof lastWithButtons>, title: string): string => {
  const c = m!.content as any;
  return c.buttons.find((b: any) => b.title === title).id;
};

import { OperationJournal } from '../../src/crm/operations/operation-journal.service';
import { operations } from '../../src/database/schema';
import type { AllowedAction } from '../../src/common/schemas';

/** Create (but do not run) an operation, as ConfirmationService would. */
export async function makeOperation(env: TestEnv, t: SeededTenant, userKey: string, action: AllowedAction, key = `test:${Math.random().toString(36).slice(2)}`) {
  const db = env.get<DbService>(DbService);
  const journal = env.get<OperationJournal>(OperationJournal);
  return db.tenantTx(t.tenantId, async (tx) => (await journal.create(tx, { tenantId: t.tenantId, userId: t.users[userKey].id, type: action.type, channel: 'whatsapp', action, idempotencyKey: key })).op);
}
export const loadOp = async (env: TestEnv, t: SeededTenant, id: string) => (await env.get<DbService>(DbService).tenantTx(t.tenantId, (tx) => tx.select().from(operations).where(eq(operations.id, id))))[0];
export const CAPTURE: AllowedAction = { type: 'capture_lead', person: { name: 'Rajesh Kumar', email: 'rajesh@abc.com', phoneE164: '+919876543210', phoneRaw: '+91 98765 43210' }, company: { name: 'ABC Industries' }, opportunity: { title: 'Rajesh Kumar — ABC Industries', stageId: 'new' }, notes: [{ text: 'Met at expo', type: 'observation' }], tasks: [{ title: 'Follow up', type: 'follow_up', dueDate: '2026-10-12', timezone: 'Asia/Kolkata' }] } as any;

/** Send a text and wait until the bot has replied and gone quiet; returns the new reply texts. */
export async function talk(env: TestEnv, t: SeededTenant, userKey: string, text: string, extra: Partial<NormalizedEvent> = {}, quietMs = 900): Promise<string[]> {
  const u = t.users[userKey];
  const channel = u.phone ? env.whatsapp : env.teams;
  const before = channel.sent.filter((m) => m.target.userId === u.id).length;
  await sendText(env, u.phone!, text, extra);
  return settle(env, channel, u.id, before, quietMs);
}
export async function settle(env: TestEnv, channel: TestEnv['whatsapp'], userId: string, before: number, quietMs = 900, timeoutMs = 25000): Promise<string[]> {
  const start = Date.now(); let last = -1; let lastChange = Date.now();
  for (;;) {
    const n = channel.sent.filter((m) => m.target.userId === userId).length;
    if (n !== last) { last = n; lastChange = Date.now(); }
    if (n > before && Date.now() - lastChange > quietMs) break;
    if (Date.now() - start > timeoutMs) throw new Error(`no reply to message (waited ${timeoutMs}ms)`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return channel.texts(userId).slice(before);
}
export async function confirmLast(env: TestEnv, t: SeededTenant, userKey: string): Promise<string[]> {
  const u = t.users[userKey];
  const before = env.whatsapp.sent.filter((m) => m.target.userId === u.id).length;
  await pressButton(env, u.phone!, buttonId(lastWithButtons(env, u.id), 'Confirm'));
  // wait for the "Saved"/"couldn't" completion message, not just the acknowledgement
  const start = Date.now();
  for (;;) {
    const texts = env.whatsapp.texts(u.id).slice(before);
    if (texts.some((x) => /✅ Saved|Part of this could not|couldn't save|can't save/.test(x))) return texts;
    if (Date.now() - start > 30000) throw new Error(`no completion message; got: ${texts.join(' | ')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
export async function seedRecords(env: TestEnv, slug: string, rows: { people?: any[]; companies?: any[]; opportunities?: any[]; tasks?: any[]; notes?: any[]; noteTargets?: any[]; taskTargets?: any[] }) {
  const ws = env.twenty.workspaces.get(slug)!;
  const mk = (r: any) => ({ id: r.id ?? crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), beeArchived: false, ...r });
  for (const [k, list] of Object.entries(rows)) for (const r of list ?? []) ws.data[k].push(mk(r));
  return ws;
}

export const FORM_RULES = {
  parserVersion: 'v1', allowedSenders: ['@mailer.acme.test'], subjectPattern: 'New enquiry',
  fieldAliases: { name: ['Name', 'Full name'], email: ['Email', 'E-mail'], phone: ['Phone', 'Mobile'], company: ['Company', 'Organisation'], message: ['Message', 'Enquiry'], submissionId: ['Submission ID'] },
  requiredFields: ['name', 'email', 'message'], templateMarkers: ['Message', 'Email'], defaultCountry: 'IN',
};

export function rawMail(o: { text?: string; html?: string; from?: string; subject?: string; id?: string; replyTo?: string }): Buffer {
  const lines = [`From: ${o.from ?? 'Acme Website <no-reply@mailer.acme.test>'}`, 'To: leads@intake.example', `Subject: ${o.subject ?? 'New enquiry from website'}`, `Message-ID: <${o.id ?? `m-${Math.random().toString(36).slice(2)}@mailer.acme.test`}>`, ...(o.replyTo ? [`Reply-To: ${o.replyTo}`] : []), 'MIME-Version: 1.0'];
  lines.push(o.html ? `Content-Type: text/html; charset=utf-8\r\n\r\n${o.html}` : `Content-Type: text/plain; charset=utf-8\r\n\r\n${o.text ?? ''}`);
  return Buffer.from(lines.join('\r\n'));
}
export const formBody = (f: { name?: string; email?: string; phone?: string; company?: string; message?: string; id?: string }) =>
  [f.name && `Name: ${f.name}`, f.email && `Email: ${f.email}`, f.phone && `Phone: ${f.phone}`, f.company && `Company: ${f.company}`, f.message && `Message: ${f.message}`, f.id && `Submission ID: ${f.id}`].filter(Boolean).join('\n');

/** Test hygiene: drop every open draft of a user (the real flow would be cancel/expire). */
export async function cancelAllDrafts(env: TestEnv, t: SeededTenant, userKey: string) {
  await env.get<DbService>(DbService).tenantTx(t.tenantId, (tx) => tx.execute(sql`update drafts set state = 'cancelled' where user_id = ${t.users[userKey].id} and state in ('collecting','awaiting_confirmation')`));
}
