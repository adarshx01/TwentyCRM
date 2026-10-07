#!/usr/bin/env node
// Builds teams-app/crm-bee-teams.zip (the installable Teams app, TM-01) from manifest.template.json.
// Usage: TEAMS_APP_ID=<entra app id> WEBSITE_URL=... PRIVACY_URL=... TERMS_URL=... node scripts/build-teams-package.mjs [version]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

const need = (k) => { if (!process.env[k]) { console.error(`${k} is required`); process.exit(1); } return process.env[k]; };
const out = join(process.cwd(), 'teams-app', 'build');
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });

// Minimal PNG writer (no dependencies): solid colour square with an optional white disc.
function png(size, bg, fg) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const rows = [];
  const r = size * 0.32; const cx = size / 2; const cy = size / 2;
  for (let y = 0; y < size; y++) { const row = [0]; for (let x = 0; x < size; x++) { const d = Math.hypot(x - cx, y - cy) < r; const [R, G, B, A] = d ? fg : bg; row.push(R, G, B, A); } rows.push(Buffer.from(row)); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(join(out, 'color.png'), png(192, [245, 179, 1, 255], [255, 255, 255, 255]));
writeFileSync(join(out, 'outline.png'), png(32, [0, 0, 0, 0], [255, 255, 255, 255]));

let manifest = readFileSync(join('teams-app', 'manifest.template.json'), 'utf8');
const vars = { APP_VERSION: process.argv[2] ?? '1.0.0', TEAMS_APP_ID: need('TEAMS_APP_ID'), WEBSITE_URL: need('WEBSITE_URL'), PRIVACY_URL: need('PRIVACY_URL'), TERMS_URL: need('TERMS_URL') };
for (const [k, v] of Object.entries(vars)) manifest = manifest.replaceAll(`{{${k}}}`, v);
JSON.parse(manifest);
writeFileSync(join(out, 'manifest.json'), manifest);
const zip = join('teams-app', 'crm-bee-teams.zip');
rmSync(zip, { force: true });
execFileSync('zip', ['-j', '-q', join(process.cwd(), zip), 'manifest.json', 'color.png', 'outline.png'], { cwd: out });
console.log(`built ${zip}`);
