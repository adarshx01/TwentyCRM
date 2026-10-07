import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import type { IntakeParsingRules } from '../database/schema';
import { normalizeEmail, normalizePhone } from '../common/utils/phone.util';
import { stripHtml } from '../common/utils/sanitize.util';
import { contentFingerprint } from '../common/utils/crypto.util';

export interface ParsedFields {
  name?: string;
  email?: string;
  phone?: string;
  phoneE164?: string | null;
  company?: string;
  message?: string;
  submissionId?: string;
}

export interface ParsedEmail {
  messageId?: string;
  from?: string;
  subject?: string;
  fields: ParsedFields;
  templateMatched: boolean;
  senderAllowed: boolean;
  suspicious: string[];
  missingRequired: string[];
  fingerprint: string;
  parserVersion: string;
  /** Visible text used for parsing; never logged */
  text: string;
}

const SPAM_PATTERNS = [/\b(viagra|cialis|casino|crypto(?:currency)? invest|bitcoin giveaway|seo services|backlinks?|loan offer|forex signals?)\b/i, /click here to (claim|win)/i, /\bwire transfer\b.*\burgent\b/i];
const INJECTION_PATTERNS = [/ignore (all |any )?(previous|above|prior) (instructions|prompts)/i, /\b(system prompt|developer message)\b/i, /you are now\b/i, /assistant,? (please )?(delete|export|send)/i, /\btenant[_ -]?id\b/i];

/** HTML → text keeping row/line structure so labelled fields survive. */
function htmlToText(html: string): string {
  const spaced = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<\/(tr|p|div|li|h[1-6])>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, '\u0001');
  return spaced.split('\n').map((line) => {
    const cells = line.split('\u0001').map((c) => stripHtml(c)).filter(Boolean);
    // A table row "Label | value" becomes "Label: value" so labelled extraction works.
    return cells.length >= 2 && !/:\s*$/.test(cells[0]) ? `${cells[0]}: ${cells.slice(1).join(' ')}` : cells.join(' ');
  }).filter(Boolean).join('\n');
}

/** Drop quoted correspondence and signatures (IN-04). */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^>/.test(line)) continue;
    if (/^On .{5,120} wrote:\s*$/i.test(line) || /^-{2,}\s*(Original|Forwarded) message\s*-{2,}$/i.test(line) || /^From:.*Sent:.*$/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Extract `Label: value` fields; a value runs until the next known label line. */
export function extractLabelled(text: string, rules: IntakeParsingRules): ParsedFields {
  const aliases = rules.fieldAliases;
  const allLabels = Object.values(aliases).flat().map((l) => l.toLowerCase());
  const labelRe = (label: string) => new RegExp(`^\\s*${escapeRe(label)}\\s*[:\\-–]\\s*(.*)$`, 'i');
  const lines = text.split(/\r?\n/);
  const isAnyLabel = (line: string) => allLabels.some((l) => labelRe(l).test(line));
  const out: Record<string, string> = {};
  for (const [field, names] of Object.entries(aliases) as Array<[keyof ParsedFields, string[]]>) {
    for (let i = 0; i < lines.length && !out[field]; i++) {
      for (const label of names) {
        const m = labelRe(label).exec(lines[i]);
        if (!m) continue;
        const parts = [m[1].trim()];
        if (field === 'message') {
          for (let j = i + 1; j < lines.length && !isAnyLabel(lines[j]) && !/^[A-Z][A-Za-z ]{1,30}:\s/.test(lines[j]); j++) parts.push(lines[j].trim());
        } else if (!parts[0] && i + 1 < lines.length && !isAnyLabel(lines[i + 1])) parts[0] = lines[i + 1].trim();
        const v = parts.join('\n').trim();
        if (v) out[field] = v;
        break;
      }
    }
  }
  return out as ParsedFields;
}

export function normalizeFields(raw: ParsedFields, rules: IntakeParsingRules): { fields: ParsedFields; suspicious: string[] } {
  const suspicious: string[] = [];
  const f: ParsedFields = { ...raw };
  if (f.name) f.name = f.name.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (f.company) f.company = f.company.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (f.message) f.message = f.message.trim().slice(0, 5000);
  if (f.email) {
    const e = normalizeEmail(f.email.replace(/^mailto:/i, ''));
    // Syntax only: a valid-looking address does not prove ownership (IN-06).
    if (/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) f.email = e; else { suspicious.push('invalid email address'); delete f.email; }
  }
  if (f.phone) {
    const p = normalizePhone(f.phone, rules.defaultCountry);
    f.phone = f.phone.trim().slice(0, 40);
    f.phoneE164 = p.e164;
    if (!p.e164 && !/^[+\d][\d\s().-]{5,}$/.test(f.phone)) { suspicious.push('invalid phone number'); delete f.phone; }
  }
  return { fields: f, suspicious };
}

export function assessContent(fields: ParsedFields, rawText: string): string[] {
  const reasons: string[] = [];
  const msg = `${fields.message ?? ''}\n${fields.name ?? ''}\n${fields.company ?? ''}`;
  if (SPAM_PATTERNS.some((r) => r.test(msg))) reasons.push('spam-like content');
  if ((msg.match(/https?:\/\//gi) ?? []).length > 3) reasons.push('many links');
  if (INJECTION_PATTERNS.some((r) => r.test(rawText))) reasons.push('instruction-like text in the email');
  return reasons;
}

export function missingRequired(fields: ParsedFields, rules: IntakeParsingRules): string[] {
  const missing: string[] = [];
  for (const r of rules.requiredFields) if (!fields[r]) missing.push(r);
  return missing;
}

/** IN-06: name or company, a valid contact method, and enquiry text. */
export function meetsAutoSaveMinimum(f: ParsedFields): boolean {
  return Boolean((f.name || f.company) && (f.email || f.phone) && f.message);
}

export function fingerprintOf(f: ParsedFields): string {
  return createHash('sha256').update([f.email ?? '', f.phoneE164 ?? f.phone?.replace(/\D/g, '') ?? '', contentFingerprint(f.message ?? '', 500)].join('|')).digest('hex');
}

export function senderAllowed(from: string | undefined, rules: IntakeParsingRules): boolean {
  if (!rules.allowedSenders?.length) return true;
  const addr = (from ?? '').toLowerCase().match(/[^\s<>]+@[^\s<>]+/)?.[0] ?? '';
  return rules.allowedSenders.some((a) => { const r = a.toLowerCase(); return r.startsWith('@') ? addr.endsWith(r) : addr === r; });
}

function subjectMatches(subject: string | undefined, rules: IntakeParsingRules): boolean {
  if (!rules.subjectPattern) return true;
  try { return new RegExp(rules.subjectPattern.slice(0, 200), 'i').test((subject ?? '').slice(0, 300)); } catch { return false; }
}

/**
 * Deterministic parse of a form-notification email (IN-04..IN-06).
 * Scripts, tracking images and quoted text are ignored; embedded URLs are never fetched;
 * attachments are never processed. The From header is the website mailer, not the visitor.
 */
export async function parseEmail(raw: Buffer, rules: IntakeParsingRules): Promise<ParsedEmail> {
  const mail = await simpleParser(raw, { skipImageLinks: true, skipHtmlToText: true, skipTextToHtml: true, skipTextLinks: true });
  const text = stripQuoted(mail.text?.trim() ? mail.text : htmlToText(typeof mail.html === 'string' ? mail.html : ''));
  const from = mail.from?.value?.[0]?.address;
  const extracted = extractLabelled(text, rules);
  if (!extracted.email && rules.replyToIsVisitor) {
    const rt = (mail.replyTo?.value?.[0]?.address) ?? undefined;
    if (rt) extracted.email = rt;
  }
  const { fields, suspicious } = normalizeFields(extracted, rules);
  const lower = text.toLowerCase();
  const templateMatched = rules.templateMarkers.every((m) => lower.includes(m.toLowerCase())) && subjectMatches(mail.subject, rules);
  return {
    messageId: mail.messageId?.replace(/^<|>$/g, ''), from, subject: mail.subject, fields, templateMatched, senderAllowed: senderAllowed(from, rules),
    suspicious: [...suspicious, ...assessContent(fields, text)], missingRequired: missingRequired(fields, rules), fingerprint: fingerprintOf(fields), parserVersion: rules.parserVersion, text,
  };
}

/** Same mapping for already-structured website events (IN-03). */
export function parseFormEvent(body: { fields: Record<string, unknown>; submissionId?: string }, rules: IntakeParsingRules): ParsedEmail {
  const lowered = new Map(Object.entries(body.fields).map(([k, v]) => [k.toLowerCase().trim(), String(v ?? '')]));
  const pick = (names: string[]) => names.map((n) => lowered.get(n.toLowerCase().replace(/[:\-–]\s*$/, ''))).find((v) => v && v.trim());
  const a = rules.fieldAliases;
  const raw: ParsedFields = { name: pick(a.name), email: pick(a.email), phone: pick(a.phone), company: pick(a.company), message: pick(a.message), submissionId: body.submissionId ?? pick(a.submissionId) };
  const { fields, suspicious } = normalizeFields(raw, rules);
  const text = Object.entries(body.fields).map(([k, v]) => `${k}: ${v}`).join('\n');
  return { fields, templateMatched: true, senderAllowed: true, suspicious: [...suspicious, ...assessContent(fields, text)], missingRequired: missingRequired(fields, rules), fingerprint: fingerprintOf(fields), parserVersion: rules.parserVersion, text, messageId: undefined };
}
