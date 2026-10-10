// LIVE role matrix against a running local stack (Twenty + Bee): real Twenty logins for client admin, salesperson,
// manager and CXO, seeded records with different owners, and checks on BOTH Twenty's native permissions and Bee's scope.
//   set -a; . ./.env.local; set +a; node scripts/verify/role-matrix.mjs
// Prerequisites: ./scripts/dev-up.sh, a provisioned tenant (examples/local-tenant.json) and Twenty logins for
// sam/meera/chris (scripts/twenty-add-member.mjs). Exits non-zero on any failure.
import { createHmac } from 'node:crypto';
import { base, gql, session } from './twenty.mjs';
const KEY = process.env.TWENTY_API_KEY;
const BEE = 'http://localhost:3400';
const creds = { admin: ['admin@crmbee.local', process.env.TWENTY_ADMIN_PASSWORD], sam: ['sam@demo.local', process.env.TWENTY_TEST_SAM_PASSWORD], meera: ['meera@demo.local', process.env.TWENTY_TEST_MEERA_PASSWORD], chris: ['chris@demo.local', process.env.TWENTY_TEST_CHRIS_PASSWORD] };
const tok = {}; for (const [k, c] of Object.entries(creds)) { const s = await session(...c); if (s.error) throw new Error(`${k} login: ${s.error}`); tok[k] = s.token; }
const relay = async (who, method, path, body) => { const r = await fetch(`${base}/s/bee/api`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok[who]}` }, body: JSON.stringify({ method, path, body }) }); const j = await r.json(); return j.status !== undefined ? j : j.data; };
const results = []; const check = (id, name, ok, detail = '') => { results.push({ id, name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(8)} ${name}${detail ? '  — ' + detail : ''}`); };

// 0. link the demo employees (explicit, by the client admin)
let users = (await relay('admin', 'GET', '/v1/tenant-admin/users')).data;
let members = (await relay('admin', 'GET', '/v1/tenant-admin/members')).data;
for (const email of ['meera@demo.local', 'chris@demo.local', 'sam@demo.local']) {
  const u = users.find((x) => x.email === email); const m = members.find((x) => x.email === email);
  if (u && m && u.twentyMemberId !== m.id) await relay('admin', 'POST', `/v1/tenant-admin/users/${u.id}/link`, { memberId: m.id });
}
await relay('admin', 'POST', '/v1/tenant-admin/access/sync');
users = (await relay('admin', 'GET', '/v1/tenant-admin/users')).data;
if (!users.find((u) => u.email === 'nina@demo.local')) {
  const c = await relay('admin', 'POST', '/v1/tenant-admin/users', { displayName: 'Nina North', email: 'nina@demo.local', role: 'salesperson', teamId: 'north' });
  if (c.status >= 400) throw new Error('create nina: ' + JSON.stringify(c.data));
  users = (await relay('admin', 'GET', '/v1/tenant-admin/users')).data;
}
const U = Object.fromEntries(users.map((u) => [u.email.split('@')[0], u]));

// 1. seed records with different owners (as "already in the CRM")
const stamp = Date.now().toString(36);
const mk = async (owner, team, label) => {
  const r = await fetch(`${base}/rest/opportunities`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: `LiveMatrix ${label} ${stamp}`, stage: 'NEW', beeOwnerMemberId: owner, beeTeamId: team ?? null, beeArchived: false }) });
  const j = await r.json(); return { id: Object.values(j.data)[0].id, label: `LiveMatrix ${label} ${stamp}` };
};
const recs = {
  sam: await mk(U.sam.id, 'north', 'Sam-owned'),
  northColleague: await mk(U.nina.id, 'north', 'North-colleague'),
  chris: await mk(U.chris.id, null, 'Chris-owned'),
  admin: await mk(U.admin.id, null, 'Admin-owned'),
};

// 2. Bee scope per role, through the real in-CRM chat path (member id → linked user → role scope)
const secret = (t) => createHmac('sha256', process.env.CRM_CHAT_TOKEN).update(`crm-bee-app:v1:${t}`).digest('hex');
const tenantId = (await relay('admin', 'GET', '/v1/me')).data.tenant.id;
const wsId = (await gql(`{ currentWorkspace { id } }`, {}, tok.admin)).data.currentWorkspace.id;
const chat = async (memberId, text) => {
  const H = { authorization: `Bearer ${secret(tenantId)}`, 'x-bee-workspace': wsId, 'x-bee-member': memberId, 'content-type': 'application/json' };
  const list = async () => (await (await fetch(`${BEE}/v1/crm-chat/messages`, { headers: H })).json()).messages ?? [];
  const n = (await list()).length;
  await fetch(`${BEE}/v1/crm-chat/send`, { method: 'POST', headers: H, body: JSON.stringify({ text }) });
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 1500)); const m = await list(); if (m.length > n) { await new Promise((r) => setTimeout(r, 2500)); return (await list()).slice(n).map((x) => x.text).join('\n'); } }
  return '(no reply)';
};
const memberOf = (u) => u.twentyMemberId;
const seen = async (who) => { const t = await chat(memberOf(U[who]), `Find LiveMatrix ${stamp}`); return Object.fromEntries(Object.entries(recs).map(([k, r]) => [k, t.includes(r.label)])); };
const expect = { sam: { sam: true, northColleague: false, chris: false, admin: false }, meera: { sam: true, northColleague: true, chris: false, admin: false }, chris: { sam: true, northColleague: true, chris: true, admin: true } };
// cancel anything left open so read-only questions run clean
for (const who of ['sam', 'meera', 'chris']) await chat(memberOf(U[who]), 'cancel');
for (const who of ['sam', 'meera', 'chris']) {
  const s = await seen(who);
  check('AT-02', `Bee search as ${who}: sees ${Object.entries(s).filter(([, v]) => v).map(([k]) => k).join('+') || 'nothing'}`, JSON.stringify(s) === JSON.stringify(expect[who]), JSON.stringify(s));
}

// 3. native Twenty permissions per role
const rest = async (who, path, opt = {}) => { const r = await fetch(`${base}${path}`, { ...opt, headers: { authorization: `Bearer ${tok[who]}`, 'content-type': 'application/json' } }); const j = await r.json().catch(() => null); return { status: r.status, j }; };
for (const who of ['sam', 'meera']) { const r = await rest(who, '/rest/opportunities?limit=5'); check('AT-02', `Twenty UI/API: ${who} cannot read opportunities`, r.status === 400 && /permission/i.test(JSON.stringify(r.j)), `${r.status}`); }
for (const who of ['sam', 'meera']) { const r = await rest(who, `/rest/opportunities/${recs.sam.id}`); check('AT-01', `Twenty direct id access: ${who} denied`, r.status >= 400, `${r.status}`); }
{ const r = await rest('chris', `/rest/opportunities?limit=60`); const names = JSON.stringify(r.j); check('AT-02', 'Twenty: CXO reads every company record', r.status === 200 && Object.values(recs).every((x) => names.includes(x.label)), `${r.status}`); }
{ const t = await mk(U.chris.id, null, 'Disposable');
  const gdel = await fetch(`${base}/graphql`, { method: 'POST', headers: { authorization: `Bearer ${tok.chris}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: `mutation($id:UUID!){ deleteOpportunity(id:$id){ id } }`, variables: { id: t.id } }) }).then((r) => r.json());
  check('§4', 'Twenty: CXO may archive (soft-delete)', !!gdel.data?.deleteOpportunity?.id, gdel.errors?.[0]?.message ?? '');
  const gdes = await fetch(`${base}/graphql`, { method: 'POST', headers: { authorization: `Bearer ${tok.chris}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: `mutation($id:UUID!){ destroyOpportunity(id:$id){ id } }`, variables: { id: t.id } }) }).then((r) => r.json());
  check('§4', 'Twenty: CXO cannot permanently destroy', !gdes.data?.destroyOpportunity?.id, gdes.errors?.[0]?.message ?? '');
}
{ const r = await fetch(`${base}/metadata`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ getRoles { id } }' }) }).then((r) => r.json()); check('§4', 'Integration key cannot manage roles (not an administrator)', !!r.errors, r.errors?.[0]?.extensions?.subCode ?? ''); }

// 4. Bee admin API per role (direct)
const adminRoutes = ['/v1/tenant-admin/users', '/v1/tenant-admin/audit', '/v1/tenant-admin/config', '/v1/tenant-admin/support'];
for (const who of ['sam', 'meera', 'chris']) { const sts = []; for (const p of adminRoutes) sts.push((await relay(who, 'GET', p)).status); check('§4', `Bee admin API denied for ${who}`, sts.every((s) => s === 403), sts.join(',')); }
{ const sts = []; for (const p of adminRoutes) sts.push((await relay('admin', 'GET', p)).status); check('§4', 'Bee admin API open to client admin', sts.every((s) => s === 200), sts.join(',')); }
{ const a = (await relay('meera', 'GET', '/v1/approvals/archive')).status, b = (await relay('sam', 'GET', '/v1/approvals/archive')).status; check('§4', 'Approvals: manager yes, salesperson no', a === 200 && b === 403, `${a}/${b}`); }

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
