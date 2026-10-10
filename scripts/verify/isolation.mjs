// LIVE two-client isolation check: client A (:3000) and client B (:3010, infra/twenty-b) with real sessions and keys.
//   set -a; . ./.env.local; set +a; node scripts/verify/isolation.mjs
// Covers AT-01 / TEN-02 / TEN-03 / CFG-01 / G3: cross-reading through Bee, cross-identity and cross-credential attempts,
// tenant-bound admin APIs and independent pipelines. Exits non-zero on any failure.
import { createHmac, randomUUID } from 'node:crypto';
const A = 'http://localhost:3000', B = 'http://localhost:3010', BEE = 'http://localhost:3400';
const E = process.env;
const gql = async (base, query, variables, token) => (await (await fetch(`${base}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json());
const login = async (base, email, pw) => {
  const a = await gql(base, `mutation($e:String!,$p:String!){getLoginTokenFromCredentials(email:$e,password:$p,origin:"${base}"){loginToken{token}}}`, { e: email, p: pw });
  if (a.errors) throw new Error(`${email}: ${a.errors[0].message}`);
  const b = await gql(base, `mutation($t:String!){getAuthTokensFromLoginToken(loginToken:$t,origin:"${base}"){tokens{accessOrWorkspaceAgnosticToken{token}}}}`, { t: a.data.getLoginTokenFromCredentials.loginToken.token });
  return b.data.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
};
const T = {
  A: { admin: await login(A, 'admin@crmbee.local', E.TWENTY_ADMIN_PASSWORD), sam: await login(A, 'sam@demo.local', E.TWENTY_TEST_SAM_PASSWORD), chris: await login(A, 'chris@demo.local', E.TWENTY_TEST_CHRIS_PASSWORD) },
  B: { admin: await login(B, 'admin@clientb.local', E.TWENTY_B_ADMIN_PASSWORD), bob: await login(B, 'bob@clientb.local', E.TWENTY_TEST_BOB_PASSWORD), beth: await login(B, 'beth@clientb.local', E.TWENTY_TEST_BETH_PASSWORD) },
};
const relay = async (base, token, method, path, body) => { const r = await fetch(`${base}/s/bee/api`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method, path, body }) }); const j = await r.json(); return j.status !== undefined ? j : j.data ?? { status: r.status, data: j }; };
const results = []; const check = (id, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(7)} ${name}${detail ? '  — ' + detail : ''}`); };
const meA = (await relay(A, T.A.admin, 'GET', '/v1/me')).data, meB = (await relay(B, T.B.admin, 'GET', '/v1/me')).data;
check('TEN-02', 'two tenants, two workspaces, distinct ids', meA.tenant.id !== meB.tenant.id, `${meA.tenant.slug} / ${meB.tenant.slug}`);

// data in each client
const stamp = Date.now().toString(36);
const mkOpp = async (base, key, owner, team, label) => { const r = await fetch(`${base}/rest/opportunities`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: label, stage: 'NEW', beeOwnerMemberId: owner, beeTeamId: team, beeArchived: false }) }); return Object.values((await r.json()).data)[0].id; };
const usersB = (await relay(B, T.B.admin, 'GET', '/v1/tenant-admin/users')).data; const beth = usersB.find((u) => u.email === 'beth@clientb.local');
const bOppLabel = `ClientB-secret-deal ${stamp}`;
const bOppId = await mkOpp(B, E.TWENTY_B_API_KEY, beth.id, 'east', bOppLabel);
const aOpp = await (await fetch(`${A}/rest/opportunities?filter=name%5Blike%5D%3A%25LiveMatrix%25&limit=1`, { headers: { authorization: `Bearer ${E.TWENTY_API_KEY}` } })).json();
const aOppId = aOpp.data.opportunities[0]?.id; const aOppName = aOpp.data.opportunities[0]?.name;
check('setup', 'client A has records to protect', !!aOppId, aOppName);

// chat helper through the in-CRM channel (derived per-tenant secret + linked member)
const secret = (tenantId) => createHmac('sha256', E.CRM_CHAT_TOKEN).update(`crm-bee-app:v1:${tenantId}`).digest('hex');
const wsOf = async (base, token) => (await gql(base, `{ currentWorkspace { id } }`, {}, token)).data.currentWorkspace.id;
const wsA = await wsOf(A, T.A.admin), wsB = await wsOf(B, T.B.admin);
const memberOf = async (base, token) => (await gql(base, `{ currentUser { workspaceMember { id } } }`, {}, token)).data.currentUser.workspaceMember.id;
const mA = { admin: await memberOf(A, T.A.admin), chris: await memberOf(A, T.A.chris) }, mB = { admin: await memberOf(B, T.B.admin), bob: await memberOf(B, T.B.bob), beth: await memberOf(B, T.B.beth) };
const rawChat = async (headers, text) => { const list = async () => (await (await fetch(`${BEE}/v1/crm-chat/messages`, { headers })).json()); const n = ((await list()).messages ?? []).length;
  const s = await fetch(`${BEE}/v1/crm-chat/send`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (s.status >= 400) return { status: s.status, text: '' };
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 1500)); const m = (await list()).messages ?? []; if (m.length > n) { await new Promise((r) => setTimeout(r, 2500)); return { status: 200, text: ((await list()).messages ?? []).slice(n).map((x) => x.text).join('\n') }; } }
  return { status: 200, text: '(no reply)' }; };
const H = (tenantId, ws, member) => ({ authorization: `Bearer ${secret(tenantId)}`, 'x-bee-workspace': ws, 'x-bee-member': member });

// 1. nobody sees the other client's records through Bee search
for (const [who, hdr] of [['A chris (CXO)', H(meA.tenant.id, wsA, mA.chris)], ['A admin', H(meA.tenant.id, wsA, mA.admin)]]) {
  await rawChat(hdr, 'cancel');
  const r = await rawChat(hdr, `Find ClientB-secret-deal ${stamp}`);
  check('AT-01', `${who} cannot find client B's record through Bee`, /^No matching records|couldn't find/i.test(r.text.trim()) && !/Matches for/i.test(r.text), r.text.split('\n')[0].slice(0, 80));
}
for (const [who, hdr] of [['B bob (manager)', H(meB.tenant.id, wsB, mB.bob)], ['B admin', H(meB.tenant.id, wsB, mB.admin)]]) {
  await rawChat(hdr, 'cancel');
  const r = await rawChat(hdr, `Find ${aOppName}`);
  check('AT-01', `${who} cannot find client A's record through Bee`, /^No matching records|couldn't find/i.test(r.text.trim()) && !/Matches for/i.test(r.text), r.text.split('\n')[0].slice(0, 80));
}
// 2. identity / credential crossing
{ const r = await fetch(`${BEE}/v1/crm-chat/messages`, { headers: H(meA.tenant.id, wsB, mB.admin) }); check('AT-01', "tenant A's app secret cannot speak for workspace B", r.status === 401, `${r.status}`); }
{ const r = await fetch(`${BEE}/v1/crm-chat/messages`, { headers: H(meB.tenant.id, wsB, mA.chris) }); check('AT-01', "an A member id is not a member of workspace B", r.status === 403, `${r.status}`); }
{ const r = await fetch(`${BEE}/v1/crm-chat/messages`, { headers: H(meA.tenant.id, wsA, mB.beth) }); check('AT-01', "a B member id is not a member of workspace A", r.status === 403, `${r.status}`); }
// 3. Twenty-level isolation: every credential is useless on the other instance
for (const [what, base, tok] of [['A admin session', B, T.A.admin], ['A salesperson session', B, T.A.sam], ['B admin session', A, T.B.admin], ['A integration key', B, E.TWENTY_API_KEY], ['B integration key', A, E.TWENTY_B_API_KEY]]) {
  const r = await fetch(`${base}/rest/opportunities?limit=1`, { headers: { authorization: `Bearer ${tok}` } }); check('AT-01', `${what} is rejected by the other client's Twenty`, r.status === 401 || r.status === 403, `${r.status}`);
}
{ const r = await fetch(`${B}/rest/opportunities/${aOppId}`, { headers: { authorization: `Bearer ${E.TWENTY_B_API_KEY}` } }); check('AT-01', "guessing A's record id inside B's own workspace finds nothing", r.status === 404 || r.status === 400, `${r.status}`); }
// 4. admin APIs are tenant-bound
{ const a = (await relay(A, T.A.admin, 'GET', '/v1/tenant-admin/users')).data, b = (await relay(B, T.B.admin, 'GET', '/v1/tenant-admin/users')).data;
  const overlap = a.filter((u) => b.some((x) => x.id === u.id)).length;
  check('TEN-03', "each client admin lists only their own users", overlap === 0 && a.every((u) => !u.email.endsWith('@clientb.local')) && b.every((u) => u.email.endsWith('@clientb.local')), `A:${a.length} B:${b.length}`);
  const r = await relay(B, T.B.admin, 'PATCH', `/v1/tenant-admin/users/${a[0].id}`, { displayName: 'hijack' }); check('TEN-03', "B admin cannot modify an A user by id", r.status === 404, `${r.status}`);
  const rv = await relay(B, T.B.admin, 'POST', `/v1/tenant-admin/users/${a[0].id}/revoke`); check('TEN-03', "B admin cannot revoke an A user by id", rv.status === 404, `${rv.status}`);
}
// 5. independent configuration (G3)
{ const ca = (await relay(A, T.A.admin, 'GET', '/v1/tenant-admin/config')).data, cb = (await relay(B, T.B.admin, 'GET', '/v1/tenant-admin/config')).data;
  check('CFG-01', 'pipelines differ per client', JSON.stringify(ca.pipeline.stages.map((s) => s.id)) !== JSON.stringify(cb.pipeline.stages.map((s) => s.id)), `A:${ca.pipeline.stages.map((s) => s.id).join('>')}  B:${cb.pipeline.stages.map((s) => s.id).join('>')}`);
  const lab = ca.pipeline.stages.find((s) => s.id === 'meeting').label;
  const up = await relay(A, T.A.admin, 'PATCH', '/v1/tenant-admin/config', { pipeline: { defaultInitialStage: ca.pipeline.defaultInitialStage, stages: ca.pipeline.stages.map((s) => (s.id === 'meeting' ? { ...s, label: 'Client meeting' } : s)) } });
  const ca2 = (await relay(A, T.A.admin, 'GET', '/v1/tenant-admin/config')).data, cb2 = (await relay(B, T.B.admin, 'GET', '/v1/tenant-admin/config')).data;
  check('G3', "renaming a stage in A changes A only (stable id kept)", up.status === 200 && ca2.pipeline.stages.find((s) => s.id === 'meeting').label === 'Client meeting' && JSON.stringify(cb2.pipeline) === JSON.stringify(cb.pipeline));
  await relay(A, T.A.admin, 'PATCH', '/v1/tenant-admin/config', { pipeline: { defaultInitialStage: ca.pipeline.defaultInitialStage, stages: ca.pipeline.stages.map((s) => (s.id === 'meeting' ? { ...s, label: lab } : s)) } });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
