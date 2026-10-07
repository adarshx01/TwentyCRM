#!/usr/bin/env node
// Create (or reuse) a Twenty admin user + workspace and mint an API key for the integration (G1/G3 groundwork).
//   TWENTY_URL=http://localhost:3000 TWENTY_ADMIN_EMAIL=… TWENTY_ADMIN_PASSWORD=… node scripts/twenty-bootstrap.mjs
// Prints JSON { workspaceId, apiKey } — put the key in a secret and reference it from the tenant manifest (env:/gcp-sm:).
const base = (process.env.TWENTY_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const email = process.env.TWENTY_ADMIN_EMAIL ?? 'admin@crmbee.local';
const password = process.env.TWENTY_ADMIN_PASSWORD;
if (!password) { console.error('TWENTY_ADMIN_PASSWORD is required'); process.exit(1); }
const gql = async (query, variables, token, origin = base) => {
  const r = await fetch(`${base}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  return j;
};
const must = (r, what) => { if (r.errors?.length) throw new Error(`${what}: ${r.errors.map((e) => e.message).join('; ')}`); return r.data; };

// 1) user (sign up, or sign in if it already exists) and the workspaces it already belongs to
const AUTH = 'tokens{accessOrWorkspaceAgnosticToken{token}} availableWorkspaces{availableWorkspacesForSignIn{id}}';
const exists = must(await gql(`query($email:String!){checkUserExists(email:$email){exists}}`, { email }), 'checkUserExists').checkUserExists.exists;
const mutation = exists ? 'signIn' : 'signUp';
const auth = must(await gql(`mutation($email:String!,$password:String!){${mutation}(email:$email,password:$password){${AUTH}}}`, { email, password }), mutation)[mutation];
const agnostic = auth.tokens.accessOrWorkspaceAgnosticToken.token;

// 2) workspace (create one if the user has none)
let workspaceId = auth.availableWorkspaces?.availableWorkspacesForSignIn?.[0]?.id;
let loginToken;
if (!workspaceId) {
  const created = must(await gql(`mutation($i:SignUpInNewWorkspaceInput){signUpInNewWorkspace(input:$i){loginToken{token} workspace{id}}}`, { i: { displayName: 'CRM Bee Dev' } }, agnostic), 'signUpInNewWorkspace').signUpInNewWorkspace;
  workspaceId = created.workspace.id; loginToken = created.loginToken.token;
} else {
  loginToken = must(await gql(`mutation($email:String!,$password:String!){getLoginTokenFromCredentials(email:$email,password:$password,origin:"${base}"){loginToken{token}}}`, { email, password }), 'getLoginTokenFromCredentials').getLoginTokenFromCredentials.loginToken.token;
}
const tokens = must(await gql(`mutation($t:String!){getAuthTokensFromLoginToken(loginToken:$t,origin:"${base}"){tokens{accessOrWorkspaceAgnosticToken{token}}}}`, { t: loginToken }), 'getAuthTokensFromLoginToken').getAuthTokensFromLoginToken.tokens;
const access = tokens.accessOrWorkspaceAgnosticToken.token;

// 3) activate (idempotent) and 4) API key with the admin role
const act = await gql(`mutation{activateWorkspace(data:{}){id activationStatus}}`, {}, access);
if (act.errors && !/already|ACTIVE/i.test(JSON.stringify(act.errors))) console.error('activateWorkspace:', JSON.stringify(act.errors).slice(0, 200));
const roles = must(await gql(`query{getRoles{id label}}`, {}, access), 'getRoles').getRoles;
const admin = roles.find((r) => /admin/i.test(r.label)) ?? roles[0];
const key = must(await gql(`mutation($i:CreateApiKeyInput!){createApiKey(input:$i){id}}`, { i: { name: `crm-bee-${Date.now()}`, expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(), roleId: admin.id } }, access), 'createApiKey').createApiKey;
const tok = must(await gql(`mutation($id:UUID!,$exp:String!){generateApiKeyToken(apiKeyId:$id,expiresAt:$exp){token}}`, { id: key.id, exp: new Date(Date.now() + 365 * 86400_000).toISOString() }, access), 'generateApiKeyToken').generateApiKeyToken.token;
console.log(JSON.stringify({ workspaceId, apiKey: tok, role: admin.label }));
