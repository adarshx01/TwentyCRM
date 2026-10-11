#!/usr/bin/env node
// One-time setup of the PLATFORM plane on a shared, multi-workspace Twenty (BRD §1):
//   1. the platform account (the server admin that creates company workspaces) and the YlogX operations workspace,
//   2. the CRM Bee app registered on the instance and installed into that workspace,
//   3. the first platform operator in Bee, linked to that account, and the app wired to Bee.
// Afterwards operators sign in to <ops workspace> › Bee › Platform to create and run companies.
//
//   PLATFORM_TWENTY_URL=http://app.localhost:3020 PLATFORM_ADMIN_EMAIL=platform@ylogx.local PLATFORM_ADMIN_PASSWORD=… \
//   BEE_API=http://localhost:3400 ADMIN_API_KEY=… CRM_CHAT_TOKEN=… BEE_APP_API_URL=http://host.docker.internal:3400 \
//   TWENTY_DB_EXEC="docker exec crmbee-twenty-m-db-1 psql -U postgres -d default -c" \
//   node scripts/platform-bootstrap.mjs
//
// Twenty has no API to make the first server admin, so the account is promoted with TWENTY_DB_EXEC (a SQL runner for
// Twenty's database). Prints the environment variables to add to Bee's configuration.
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const E = process.env;
const need = (k) => { if (!E[k]) { console.error(`${k} is required`); process.exit(1); } return E[k]; };
const APP = need('PLATFORM_TWENTY_URL').replace(/\/$/, '');
const email = need('PLATFORM_ADMIN_EMAIL'), password = need('PLATFORM_ADMIN_PASSWORD');
const BEE = need('BEE_API').replace(/\/$/, ''), ADMIN = need('ADMIN_API_KEY'), CHAT = need('CRM_CHAT_TOKEN');
const BEE_FOR_APP = E.BEE_APP_API_URL ?? BEE;
const APP_ID = E.TWENTY_APP_UNIVERSAL_ID ?? '9b650bfb-85fc-478d-961a-a40ee10235dc';
const SUBDOMAIN = E.PLATFORM_SUBDOMAIN ?? 'ylogx';

const gql = async (host, query, variables, token) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${host}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: host, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
      return await r.json();
    } catch (e) { if (i >= 20) throw e; await new Promise((r) => setTimeout(r, 3000)); } // the server may be restarting
  }
};
const must = (r, w) => { if (r.errors?.length) throw new Error(`${w}: ${r.errors[0].message}`); return r.data; };
const login = async (host) => {
  const a = must(await gql(host, `mutation($e:String!,$p:String!,$o:String!){ getLoginTokenFromCredentials(email:$e,password:$p,origin:$o){ loginToken{token} } }`, { e: email, p: password, o: host }), 'login');
  return must(await gql(host, `mutation($t:String!,$o:String!){ getAuthTokensFromLoginToken(loginToken:$t,origin:$o){ tokens{accessOrWorkspaceAgnosticToken{token}} } }`, { t: a.getLoginTokenFromCredentials.loginToken.token, o: host }), 'tokens').getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
};

// 1. platform account + operations workspace
const exists = must(await gql(APP, `query($e:String!){checkUserExists(email:$e){exists}}`, { e: email }), 'checkUserExists').checkUserExists.exists;
const auth = must(await gql(APP, `mutation($e:String!,$p:String!){ ${exists ? 'signIn' : 'signUp'}(email:$e,password:$p){ tokens{accessOrWorkspaceAgnosticToken{token}} availableWorkspaces{availableWorkspacesForSignIn{id displayName workspaceUrls{subdomainUrl}}} } }`, { e: email, p: password }), exists ? 'signIn' : 'signUp')[exists ? 'signIn' : 'signUp'];
let ws = auth.availableWorkspaces.availableWorkspacesForSignIn.find((w) => /platform/i.test(w.displayName));
if (!ws) {
  const created = must(await gql(APP, `mutation($i:SignUpInNewWorkspaceInput){ signUpInNewWorkspace(input:$i){ workspace{ id workspaceUrls{ subdomainUrl } } } }`, { i: { displayName: 'YlogX Platform' } }, auth.tokens.accessOrWorkspaceAgnosticToken.token), 'signUpInNewWorkspace').signUpInNewWorkspace.workspace;
  ws = created;
  const host0 = ws.workspaceUrls.subdomainUrl.replace(/\/$/, '');
  const t0 = await login(host0);
  must(await gql(host0, `mutation{ activateWorkspace(data:{displayName:"YlogX Platform"}){ id } }`, {}, t0), 'activateWorkspace');
  must(await gql(host0, `mutation($d:UpdateWorkspaceInput!){ updateWorkspace(data:$d){ id } }`, { d: { subdomain: SUBDOMAIN } }, t0), 'subdomain');
  ws.workspaceUrls.subdomainUrl = host0.replace(/\/\/[^.]+\./, `//${SUBDOMAIN}.`);
}
const host = ws.workspaceUrls.subdomainUrl.replace(/\/$/, '');
console.error(`platform workspace: ${ws.id} at ${host}`);

// 2. server admin (needed to create further workspaces)
if (E.TWENTY_DB_EXEC) {
  execSync(`${E.TWENTY_DB_EXEC} "update core.\\"user\\" set \\"canAccessFullAdminPanel\\"=true, \\"canImpersonate\\"=true where email='${email.replace(/'/g, '')}'"`, { stdio: 'ignore' });
  console.error('platform account promoted to server admin');
} else console.error('NOTE: set TWENTY_DB_EXEC to promote the platform account to server admin (required to create company workspaces).');

// 2b. a previous interrupted run may have left the workspace un-activated
{
  const t = await login(host);
  const st = must(await gql(host, `{ currentWorkspace { activationStatus } }`, {}, t), 'currentWorkspace').currentWorkspace.activationStatus;
  if (st !== 'ACTIVE') must(await gql(host, `mutation{ activateWorkspace(data:{displayName:"YlogX Platform"}){ id } }`, {}, t), 'activateWorkspace');
}

// 2c. operators who join the operations workspace get a console-only role: no CRM object access, no settings
{
  const t = await login(host);
  const label = 'Platform operator';
  let roles = must(await gql(host, `{ getRoles { id label } }`, {}, t), 'roles').getRoles;
  let role = roles.find((r) => r.label === label);
  if (!role) {
    must(await gql(host, `mutation($i: CreateRoleInput!){ createOneRole(createRoleInput:$i){ id } }`, { i: { label, description: 'YlogX operators: use the Platform console only.', icon: 'IconShieldLock', canReadAllObjectRecords: false, canUpdateAllObjectRecords: false, canSoftDeleteAllObjectRecords: false, canDestroyAllObjectRecords: false, canUpdateAllSettings: false, canAccessAllTools: false, canBeAssignedToUsers: true } }, t), 'createOneRole');
    roles = must(await gql(host, `{ getRoles { id label } }`, {}, t), 'roles').getRoles;
    role = roles.find((r) => r.label === label);
  }
  must(await gql(host, `mutation($d: UpdateWorkspaceInput!){ updateWorkspace(data:$d){ id } }`, { d: { defaultRoleId: role.id, isPublicInviteLinkEnabled: false } }, t), 'workspace settings');
}

// 3. deploy key → publish + install the app in the operations workspace
const token = await login(host);
const roles = must(await gql(host, `{ getRoles { id label } }`, {}, token), 'roles').getRoles;
const exp = new Date(Date.now() + 14 * 86400_000).toISOString();
const keyId = must(await gql(host, `mutation($i:CreateApiKeyInput!){ createApiKey(input:$i){ id } }`, { i: { name: `bee-platform-deploy-${Date.now()}`, expiresAt: exp, roleId: roles.find((r) => r.label === 'Admin').id } }, token), 'createApiKey').createApiKey.id;
const deployKey = must(await gql(host, `mutation($id:UUID!,$e:String!){ generateApiKeyToken(apiKeyId:$id,expiresAt:$e){ token } }`, { id: keyId, e: exp }, token), 'key token').generateApiKeyToken.token;
const appDir = resolve(fileURLToPath(new URL('../twenty-app', import.meta.url)));
const sh = (c) => execSync(c, { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
sh(`npx twenty remote:add --url ${host} --api-key ${deployKey} --as platform`);
sh('npx twenty remote:use platform');
try {
  console.error(sh('npx twenty app:publish --private').split('\n').filter((l) => /Published|rror/.test(l)).join('\n'));
} catch (e) {
  const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  if (!/must be higher than the currently deployed/.test(out)) throw e;
  console.error('app version already published on this instance (bump twenty-app/package.json to publish changes)');
}
const inst = await gql(host, `mutation($u:String!){ installApplication(universalIdentifier:$u){ id } }`, { u: APP_ID }, token);
if (inst.errors && !/already/i.test(inst.errors[0].message)) throw new Error(`installApplication: ${inst.errors[0].message}`);
console.error('CRM Bee app registered and installed in the platform workspace');

// 4. first operator in Bee, linked to the platform account's member
const bee = async (path, body, method = 'POST') => (await fetch(`${BEE}${path}`, { method, headers: { 'x-api-key': ADMIN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const ops = await bee('/admin/operators', undefined, 'GET');
let op = (Array.isArray(ops) ? ops : []).find((o) => o.email === email.toLowerCase());
if (!op) { const c = await bee('/admin/operators', { name: E.PLATFORM_OPERATOR_NAME ?? 'Platform admin', email }); op = { id: c.id }; if (c.key) console.error(`operator API key (shown once, for CLI use): ${c.key}`); }
const member = must(await gql(host, `{ currentUser { workspaceMember { id } } }`, {}, token), 'currentUser').currentUser.workspaceMember.id;
await bee(`/admin/operators/${op.id}/link`, { memberId: member });

// 5. wire the app in the operations workspace to Bee (platform-wide secret derived from the master key)
const secret = createHmac('sha256', CHAT).update('crm-bee-app:v1:platform').digest('hex');
const apps = must(await gql(host, `{ findManyApplications { id name } }`, {}, token), 'apps').findManyApplications;
const appId = apps.find((a) => a.name === 'CRM Bee').id;
for (const [k, v] of Object.entries({ BEE_CHAT_TOKEN: secret, BEE_API_URL: BEE_FOR_APP, ...(E.TWENTY_INTERNAL_URL ? { TWENTY_INTERNAL_URL: E.TWENTY_INTERNAL_URL } : {}) })) {
  must(await gql(host, `mutation($k:String!,$v:String!,$a:UUID){ updateOneApplicationVariable(key:$k,value:$v,applicationId:$a) }`, { k, v, a: appId }, token), `variable ${k}`);
}
console.error('app wired to Bee. Add to Bee configuration and restart:\n');
console.log(`PLATFORM_WORKSPACE_ID=${ws.id}\nPLATFORM_WORKSPACE_URL=${host}\nPLATFORM_TWENTY_URL=${APP}\nPLATFORM_ADMIN_EMAIL=${email}\nPLATFORM_ADMIN_PASSWORD=<the platform account password>`);
