// k6 run -e BASE_URL=… -e ADMIN_API_KEY=… -e TENANT_ID=… -e USER_IDS=uuid1,uuid2,… load/concurrent-sessions.js
// 100 simultaneous active API sessions polling their drafts/operations (the chat path is covered by webhook-burst.js).
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = { vus: 100, duration: '5m', thresholds: { http_req_duration: ['p(95)<1000'], http_req_failed: ['rate<0.001'] } };
const users = (__ENV.USER_IDS || '').split(',').filter(Boolean);

export function setup() {
  return users.map((u) => http.post(`${__ENV.BASE_URL}/admin/tenants/${__ENV.TENANT_ID}/users/${u}/token`, null, { headers: { 'x-api-key': __ENV.ADMIN_API_KEY } }).json('token'));
}

export default function (tokens) {
  const t = tokens[__VU % tokens.length];
  const r = http.get(`${__ENV.BASE_URL}/intake/review`, { headers: { authorization: `Bearer ${t}` } });
  check(r, { 'ok or forbidden for non-reviewers': (x) => x.status === 200 || x.status === 403 });
  sleep(1 + Math.random() * 2);
}
