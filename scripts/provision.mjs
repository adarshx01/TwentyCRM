#!/usr/bin/env node
// Provision (or re-run, idempotently) a tenant from a manifest through the admin API (CFG-02).
//   ADMIN_API_URL=https://crm-bee.example.com ADMIN_API_KEY=... node scripts/provision.mjs manifest.json [--dry-run]
import { readFileSync } from 'node:fs';
const [file, flag] = process.argv.slice(2);
if (!file || !process.env.ADMIN_API_URL || !process.env.ADMIN_API_KEY) { console.error('usage: ADMIN_API_URL=… ADMIN_API_KEY=… provision.mjs <manifest.json> [--dry-run]'); process.exit(1); }
const res = await fetch(`${process.env.ADMIN_API_URL.replace(/\/$/, '')}/admin/tenants${flag === '--dry-run' ? '?dryRun=true' : ''}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ADMIN_API_KEY }, body: readFileSync(file, 'utf8'),
});
console.log(res.status, JSON.stringify(await res.json(), null, 2));
process.exit(res.ok ? 0 : 1);
