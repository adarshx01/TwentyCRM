// LIVE check of the platform plane (BRD §1/§4): operators in the YlogX operations workspace create companies, each in its
// own Twenty workspace with separated data; operators have no access to company data without a client-approved grant.
//   set -a; . ./.env.local; set +a; node scripts/verify/platform.mjs
// Local run: invitations are read from the Twenty worker's log (EMAIL_DRIVER=LOGGER). Exits non-zero on any failure.
import { execSync } from 'node:child_process';
import { gql, must, login, bee } from './platform-lib.mjs';

const E = process.env;
const OPS = E.PLATFORM_WORKSPACE_URL ?? 'http://ylogx.localhost:3020';
const WORKER = E.TWENTY_M_WORKER ?? 'crmbee-twenty-m-worker-1';
const DB = E.TWENTY_M_DB ?? 'crmbee-twenty-m-db-1';
const KNOWN = { 'priya@acme.example': 'Priya-Acme-7391x', 'rohan@globex.example': 'Rohan-Glob-5512x' }; // set on first acceptance
const pw = (n) => KNOWN[n] ?? `Pw-${n}-7391xQ`;
const results = []; const check = (id, name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(6)} ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (slug) => OPS.replace(/\/\/[^.]+\./, `//${slug}.`);

const op = await login(OPS, E.PLATFORM_ADMIN_EMAIL, E.PLATFORM_ADMIN_PASSWORD);
const P = (m, p, b) => bee(OPS, op, m, p, b);
const me = (await P('GET', '/v1/me')).data;
check('P-01', 'operator signs in to the operations workspace and is a platform operator', me.platform === true && me.linked === true, me.operator?.name);

// ── create two companies (idempotent) ──────────────────────
const COMPANIES = [
  { name: 'Acme Foods', slug: 'acme-foods', adminName: 'Priya Sharma', adminEmail: 'priya@acme.example', tz: 'Asia/Kolkata', cur: 'INR' },
  { name: 'Globex Retail', slug: 'globex-retail', adminName: 'Rohan Mehta', adminEmail: 'rohan@globex.example', tz: 'Europe/London', cur: 'GBP' },
];
for (const c of COMPANIES) {
  const have = (await P('GET', '/v1/platform/companies')).data.find((x) => x.slug === c.slug);
  if (have) continue;
  const r = await P('POST', '/v1/platform/companies', { name: c.name, slug: c.slug, adminName: c.adminName, adminEmail: c.adminEmail, timezone: c.tz, defaultCurrency: c.cur, morningReminderTime: '09:00', pipelinePreset: 'standard', teams: [{ key: 'north', name: 'North' }] });
  if (r.status >= 300) { console.log('create failed', JSON.stringify(r)); process.exit(1); }
}
for (let i = 0; i < 90; i++) {
  const prog = (await P('GET', '/v1/platform/companies/in-progress')).data;
  const mine = prog.filter((p) => COMPANIES.some((c) => c.slug === p.slug));
  if (mine.length === COMPANIES.length && mine.every((p) => p.state !== 'running')) break;
  await sleep(4000);
}
const list = (await P('GET', '/v1/platform/companies')).data;
const co = Object.fromEntries(COMPANIES.map((c) => [c.slug, list.find((x) => x.slug === c.slug)]));
check('P-02', 'two companies exist, each with its own workspace address', COMPANIES.every((c) => co[c.slug]?.status === 'active') && co['acme-foods'].workspaceUrl !== co['globex-retail'].workspaceUrl, `${co['acme-foods']?.workspaceUrl} / ${co['globex-retail']?.workspaceUrl}`);

// ── client admins accept their invitations ─────────────────
const wsId = (slug) => execSync(`docker exec ${DB} psql -U postgres -d default -tAc "select id from core.workspace where subdomain='${slug}'"`, { encoding: 'utf8' }).trim();
const invite = (slug, email) => {
  const log = execSync(`docker logs ${WORKER} 2>&1`, { encoding: 'utf8', maxBuffer: 1 << 28 });
  const re = new RegExp(`${hostOf(slug).replace(/\./g, '\\.')}/invite/([0-9a-f-]+)\\?inviteToken=([0-9a-f]+)&email=${encodeURIComponent(email).replace(/\./g, '\\.')}`, 'g');
  const all = [...log.matchAll(re)]; return all[all.length - 1];
};
const join = async (slug, email) => {
  const host = hostOf(slug);
  try { return await login(host, email, pw(email)); } catch { /* not a member yet */ }
  const m = invite(slug, email); if (!m) throw new Error(`no invitation for ${email}`);
  must(await gql(host, `mutation($e:String!,$p:String!,$h:String,$t:String,$w:UUID){ signUpInWorkspace(email:$e,password:$p,workspaceInviteHash:$h,workspacePersonalInviteToken:$t,workspaceId:$w){ loginToken{token} } }`, { e: email, p: pw(email), h: m[1], t: m[2], w: wsId(slug) }), 'signUpInWorkspace');
  return login(host, email, pw(email));
};
const priya = await join('acme-foods', 'priya@acme.example'), rohan = await join('globex-retail', 'rohan@globex.example');
const A = hostOf('acme-foods'), G = hostOf('globex-retail');
const meP = (await bee(A, priya, 'GET', '/v1/me')).data, meR = (await bee(G, rohan, 'GET', '/v1/me')).data;
check('P-03', 'each client admin is linked automatically and holds the client-admin role in their own company', meP.user?.role === 'client_admin' && meR.user?.role === 'client_admin' && meP.tenant.slug === 'acme-foods' && meR.tenant.slug === 'globex-retail', `${meP.user?.displayName} @ ${meP.tenant?.slug}; ${meR.user?.displayName} @ ${meR.tenant?.slug}`);

// ── a salesperson in Acme ──────────────────────────────────
let sam = null;
const usersA0 = (await bee(A, priya, 'GET', '/v1/tenant-admin/users')).data;
if (!usersA0.some((u) => u.email === 'sam@acme.example')) {
  const c = await bee(A, priya, 'POST', '/v1/tenant-admin/users', { displayName: 'Sam Seller', email: 'sam@acme.example', role: 'salesperson', teamId: 'north' });
  check('P-04a', 'client admin adds a salesperson and the invitation goes out', c.status === 201 && c.data.invitation?.sent === true, JSON.stringify(c.data.invitation));
}
for (let i = 0; i < 10 && !sam; i++) { try { sam = await join('acme-foods', 'sam@acme.example'); } catch { await sleep(2000); } }
const meS = sam ? (await bee(A, sam, 'GET', '/v1/me')).data : null;
check('P-04', 'the salesperson joins, is linked, and sees only their own scope', meS?.user?.role === 'salesperson' && meS?.scope === 'own', `${meS?.user?.role}/${meS?.scope}`);
const usersG = (await bee(G, rohan, 'GET', '/v1/tenant-admin/users')).data;
const usersA = (await bee(A, priya, 'GET', '/v1/tenant-admin/users')).data;
check('P-05', 'each company\'s user list contains only its own people', usersA.every((u) => /@acme\.example$/.test(u.email)) && usersG.every((u) => /@globex\.example$/.test(u.email)) && usersA.length >= 2, `acme=${usersA.length} globex=${usersG.length}`);
const salesTry = await bee(A, sam, 'GET', '/v1/tenant-admin/users');
check('P-06', 'a salesperson cannot use the administration API', salesTry.status === 403, `status ${salesTry.status}`);

// ── data separation inside Twenty ──────────────────────────
const stamp = Date.now().toString(36);
const secret = `AcmeOnly-${stamp}`;
const rest = async (host, tok, method, path, body) => { const r = await fetch(`${host}/rest/${path}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const made = await rest(A, priya, 'POST', 'companies', { name: secret });
check('P-07', 'Acme admin creates a record in the Acme workspace', made.status < 300, `status ${made.status}`);
const seenG = await rest(G, rohan, 'GET', `companies?filter=name%5Blike%5D%3A%25${secret}%25&limit=5`);
const seenA = await rest(A, priya, 'GET', `companies?filter=name%5Blike%5D%3A%25${secret}%25&limit=5`);
const countOf = (r) => (r.body?.data?.companies ?? []).length;
check('P-08', 'the record is visible in Acme and invisible in Globex', countOf(seenA) === 1 && countOf(seenG) === 0, `acme=${countOf(seenA)} globex=${countOf(seenG)}`);
// Twenty resolves the workspace from the token, so a credential can only ever address its own workspace. Prove that
// a token presented at the other company's address still returns only its own company's data.
const gSecret = `GlobexOnly-${stamp}`;
await rest(G, rohan, 'POST', 'companies', { name: gSecret });
const q = (s) => `companies?filter=name%5Blike%5D%3A%25${s}%25&limit=5`;
const priyaAtG = await rest(G, priya, 'GET', q(gSecret));       // Acme token, Globex address, Globex record
const rohanAtA = await rest(A, rohan, 'GET', q(secret));         // Globex token, Acme address, Acme record
const priyaAtGOwn = await rest(G, priya, 'GET', q(secret));      // …and it still resolves to Acme's own data
check('P-09', 'a credential presented at another company\'s address reveals none of that company\'s data', countOf(priyaAtG) === 0 && countOf(rohanAtA) === 0 && countOf(priyaAtGOwn) === 1, `acme-token@globex sees globex=${countOf(priyaAtG)}; globex-token@acme sees acme=${countOf(rohanAtA)}`);
const crossRelay = await bee(G, priya, 'GET', '/v1/me');
check('P-09b', 'the Bee relay refuses a credential from another workspace', crossRelay.status >= 400, `status ${crossRelay.status}`);

// ── what the platform operator can and cannot do ───────────
let opIntoAcme = true; try { await login(A, E.PLATFORM_ADMIN_EMAIL, E.PLATFORM_ADMIN_PASSWORD); } catch { opIntoAcme = false; }
check('P-10', 'the platform account cannot sign in to a company workspace', opIntoAcme === false);
const acmeId = co['acme-foods'].id;
const detail = (await P('GET', `/v1/platform/companies/${acmeId}`)).data;
check('P-11', 'the operator sees people and health, never records', Array.isArray(detail.users) && !JSON.stringify(detail).includes(secret));
check('P-12', 'a client admin cannot use the platform API', (await bee(A, priya, 'GET', '/v1/platform/companies')).status === 403);
const auditNo = await P('GET', `/v1/platform/companies/${acmeId}/audit`);
check('P-13', 'the company audit trail is closed to operators without a grant', auditNo.status === 403, `status ${auditNo.status}`);

// ── support grant ──────────────────────────────────────────
const rq = await P('POST', `/v1/platform/companies/${acmeId}/support-request`, { reason: 'Investigating a failed import for Acme', hours: 1 });
const pend = (await bee(A, priya, 'GET', '/v1/tenant-admin/support')).data.find((g) => g.id === rq.data?.id);
check('P-14', 'the client admin sees the operator\'s support request', rq.status < 300 && !!pend, pend?.reason);
const stillNo = await P('GET', `/v1/platform/companies/${acmeId}/audit`);
const appr = await bee(A, priya, 'POST', `/v1/tenant-admin/support/${rq.data?.id}/approve`);
const okNow = await P('GET', `/v1/platform/companies/${acmeId}/audit`);
check('P-15', 'access opens only after the client approves', stillNo.status === 403 && appr.status < 300 && okNow.status === 200, `before ${stillNo.status}, after ${okNow.status}`);
await bee(A, priya, 'POST', `/v1/tenant-admin/support/${rq.data?.id}/revoke`);
const closed = await P('GET', `/v1/platform/companies/${acmeId}/audit`);
check('P-16', 'the client can withdraw access at any time', closed.status === 403, `status ${closed.status}`);

// ── suspend / reactivate ───────────────────────────────────
await P('POST', `/v1/platform/companies/${acmeId}/suspend`, { reason: 'verification' });
const susp = await bee(A, priya, 'GET', '/v1/me'); const suspS = await bee(A, sam, 'GET', '/v1/me'); const otherOk = await bee(G, rohan, 'GET', '/v1/me');
check('P-17', 'a suspended company is locked out while other companies are unaffected', susp.status >= 400 && suspS.status >= 400 && otherOk.status === 200, `acme ${susp.status}/${suspS.status}, globex ${otherOk.status}`);
await P('POST', `/v1/platform/companies/${acmeId}/reactivate`, {});
const back = await bee(A, priya, 'GET', '/v1/me');
check('P-18', 'reactivation restores access', back.status === 200 && back.data.linked === true, `status ${back.status}`);

const act = (await P('GET', '/v1/platform/audit?limit=100')).data.map((a) => a.action);
check('P-19', 'every platform action is in the operator audit trail', ['company.created', 'support.requested', 'company.suspended', 'company.reactivated'].every((a) => act.includes(a)), [...new Set(act)].join(', '));

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
