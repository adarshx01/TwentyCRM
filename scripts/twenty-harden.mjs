#!/usr/bin/env node
// One-time hardening of a client's Twenty workspace that Twenty only allows from a signed-in admin session
// (not from an API key): new members get "Bee · No access" by default, no public invite link, no impersonation.
// Run AFTER Bee provisioning (which creates the Bee roles):
//   TWENTY_URL=http://localhost:3000 TWENTY_ADMIN_EMAIL=… TWENTY_ADMIN_PASSWORD=… node scripts/twenty-harden.mjs
const base = (process.env.TWENTY_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const email = process.env.TWENTY_ADMIN_EMAIL ?? 'admin@crmbee.local';
const password = process.env.TWENTY_ADMIN_PASSWORD;
if (!password) { console.error('TWENTY_ADMIN_PASSWORD is required'); process.exit(1); }
const gql = async (query, variables, token) => {
  const r = await fetch(`${base}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
};
// Same sign-in flow as scripts/twenty-bootstrap.mjs: credentials → login token → workspace access token.
const loginToken = (await gql(`mutation($email:String!,$password:String!){getLoginTokenFromCredentials(email:$email,password:$password,origin:"${base}"){loginToken{token}}}`, { email, password })).getLoginTokenFromCredentials.loginToken.token;
const token = (await gql(`mutation($t:String!){getAuthTokensFromLoginToken(loginToken:$t,origin:"${base}"){tokens{accessOrWorkspaceAgnosticToken{token}}}}`, { t: loginToken })).getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
const roles = (await gql(`{ getRoles { id label } }`, {}, token)).getRoles;
const none = roles.find((r) => r.label === 'Bee · No access');
if (!none) { console.error('Run Bee provisioning first: the "Bee · No access" role does not exist yet.'); process.exit(1); }
await gql(`mutation($d: UpdateWorkspaceInput!) { updateWorkspace(data: $d) { id } }`, { d: { defaultRoleId: none.id, isPublicInviteLinkEnabled: false, allowImpersonation: false } }, token);
const after = (await gql(`{ currentWorkspace { id defaultRole { label } isPublicInviteLinkEnabled allowImpersonation } }`, {}, token)).currentWorkspace;
console.log(JSON.stringify(after));
