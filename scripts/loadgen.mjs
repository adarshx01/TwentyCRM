#!/usr/bin/env node
// Dependency-free load generator for the §10 webhook envelope (k6 alternative).
//   BASE_URL=http://localhost:3000 WA_APP_SECRET=… PHONE_NUMBER_ID=… SENDERS=919800000001,… node scripts/loadgen.mjs 20 60
// args: <events per second> <duration seconds>. Prints acceptance latency percentiles and error counts.
import { createHmac } from 'node:crypto';
const [rate = 20, seconds = 60] = process.argv.slice(2).map(Number);
const base = process.env.BASE_URL ?? 'http://localhost:3000';
const secret = process.env.WA_APP_SECRET; const pnid = process.env.PHONE_NUMBER_ID;
if (!secret || !pnid) { console.error('WA_APP_SECRET and PHONE_NUMBER_ID are required'); process.exit(1); }
const senders = (process.env.SENDERS ?? '919800000001').split(',');
const lat = []; let ok = 0; let bad = 0; let n = 0; const run = Date.now();
async function one(i) {
  const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: pnid }, messages: [{ id: `lg.${run}.${i}`, from: senders[i % senders.length], timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'help' } }] } }] }] });
  const t = performance.now();
  try {
    const r = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body });
    await r.arrayBuffer(); lat.push(performance.now() - t); r.status === 200 ? ok++ : bad++;
  } catch { bad++; }
}
const inflight = [];
for (let s = 0; s < seconds; s++) {
  const tick = Date.now();
  for (let k = 0; k < rate; k++) inflight.push(one(n++));
  await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - tick))));
}
await Promise.all(inflight);
const p = (q) => lat.sort((a, b) => a - b)[Math.min(lat.length - 1, Math.floor(q * lat.length))]?.toFixed(0);
console.log(JSON.stringify({ events: n, ok, failed: bad, p50_ms: +p(0.5), p95_ms: +p(0.95), p99_ms: +p(0.99), max_ms: +Math.max(...lat).toFixed(0), durationSeconds: seconds, rate }));
