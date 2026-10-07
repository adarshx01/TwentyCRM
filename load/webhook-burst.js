// k6 run -e BASE_URL=https://staging.example.com -e WA_APP_SECRET=... -e PHONE_NUMBER_ID=... -e SENDERS=919800000001,919800000002 load/webhook-burst.js
// §10 envelope: 20 events/s for 60 s (burst), after 5 events/s sustained. Target: durable acceptance p95 < 2 s.
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const accept = new Trend('webhook_accept_ms', true);
const senders = (__ENV.SENDERS || '919800000001').split(',');

export const options = {
  scenarios: {
    sustained: { executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: '30m', preAllocatedVUs: 20, maxVUs: 100, exec: 'send' },
    burst: { executor: 'constant-arrival-rate', startTime: '10m', rate: 20, timeUnit: '1s', duration: '60s', preAllocatedVUs: 60, maxVUs: 200, exec: 'send' },
  },
  thresholds: { webhook_accept_ms: ['p(95)<2000'], http_req_failed: ['rate<0.001'] },
};

export function send() {
  const id = `wamid.k6.${__VU}.${__ITER}.${Date.now()}`;
  const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: __ENV.PHONE_NUMBER_ID }, messages: [{ id, from: senders[__ITER % senders.length], timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'help' } }] } }] }] });
  const sig = `sha256=${crypto.hmac('sha256', __ENV.WA_APP_SECRET, body, 'hex')}`;
  const res = http.post(`${__ENV.BASE_URL}/webhooks/whatsapp`, body, { headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
  accept.add(res.timings.duration);
  check(res, { 'accepted (200)': (r) => r.status === 200 });
}
