#!/usr/bin/env node
// Extraction evaluation harness (BRD §5): run representative business cards and voice notes through the configured
// provider and report exact-match accuracy per field, abstentions and word-error rate. Requires `pnpm build`.
//
//   OPENAI_API_KEY=… DEFAULT_COUNTRY=IN node scripts/eval-extraction.mjs eval/manifest.json
//
// manifest.json: { "cards": [{ "file": "cards/001.jpg", "expected": { "name": "…", "email": "…", "phone": "+91…", "company": "…", "title": "…" } }],
//                  "voice": [{ "file": "voice/001.ogg", "expected": "reference transcript" }] }
// Target (BRD): ≥ 95 % exact normalized extraction of legible email/phone fields on ≥ 100 cards and ≥ 50 voice notes
// (Indian accents, international contacts, background noise). Uncertain transcription must never bypass confirmation.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const manifestPath = process.argv[2];
if (!manifestPath) { console.error('usage: eval-extraction.mjs <manifest.json>'); process.exit(1); }
const { OpenAiProvider } = await import('../dist/extraction/openai.provider.js');
const { normalizePhone, normalizeEmail } = await import('../dist/common/utils/phone.util.js');
const cfg = { openai: { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini', visionModel: process.env.OPENAI_VISION_MODEL ?? 'gpt-4o', sttModel: process.env.OPENAI_STT_MODEL ?? 'whisper-1', baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1' } };
const provider = new OpenAiProvider(cfg, fetch);
const dir = dirname(manifestPath); const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const mime = (f) => (f.endsWith('.png') ? 'image/png' : f.endsWith('.ogg') ? 'audio/ogg' : f.endsWith('.mp3') ? 'audio/mpeg' : f.endsWith('.wav') ? 'audio/wav' : f.endsWith('.m4a') ? 'audio/mp4' : 'image/jpeg');
const norm = { email: (v) => (v ? normalizeEmail(v) : ''), phone: (v) => (v ? (normalizePhone(v, process.env.DEFAULT_COUNTRY).e164 ?? v.replace(/\D/g, '')) : ''), name: (v) => (v ?? '').toLowerCase().replace(/\s+/g, ' ').trim(), company: (v) => (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), title: (v) => (v ?? '').toLowerCase().replace(/\s+/g, ' ').trim() };
const fields = ['name', 'title', 'company', 'email', 'phone']; const stat = Object.fromEntries(fields.map((f) => [f, { expected: 0, exact: 0, abstained: 0, wrong: 0 }]));
for (const c of m.cards ?? []) {
  const { data } = await provider.extractCard(readFileSync(join(dir, c.file)), mime(c.file));
  const got = { name: data.name, title: data.title, company: data.company, email: data.email, phone: data.phones?.[0] };
  for (const f of fields) { if (!c.expected[f]) continue; const s = stat[f]; s.expected++; const g = norm[f](got[f]); if (!g) s.abstained++; else if (g === norm[f](c.expected[f])) s.exact++; else s.wrong++; }
}
const wer = [];
for (const v of m.voice ?? []) {
  const { text } = await provider.transcribe(readFileSync(join(dir, v.file)), mime(v.file));
  const r = v.expected.toLowerCase().split(/\s+/); const h = text.toLowerCase().split(/\s+/);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]); for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  wer.push(d[r.length][h.length] / Math.max(1, r.length));
}
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
console.log(`cards=${m.cards?.length ?? 0} voice=${m.voice?.length ?? 0}`);
for (const f of fields) { const s = stat[f]; console.log(`${f.padEnd(8)} exact ${pct(s.exact, s.expected)}  wrong ${pct(s.wrong, s.expected)}  abstained ${pct(s.abstained, s.expected)}  (n=${s.expected})`); }
if (wer.length) console.log(`voice word-error-rate mean ${(wer.reduce((a, b) => a + b, 0) / wer.length * 100).toFixed(1)}%`);
const ok = ['email', 'phone'].every((f) => stat[f].expected === 0 || stat[f].exact / stat[f].expected >= 0.95);
console.log(ok ? 'MEETS the ≥95% email/phone target' : 'BELOW the ≥95% email/phone target (or no data)');
process.exit(ok ? 0 : 2);
