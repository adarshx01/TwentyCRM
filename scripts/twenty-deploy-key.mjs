#!/usr/bin/env node
// Mint an ADMIN-role API key for the Twenty CLI (`twenty apply`, installing/updating the CRM Bee app).
// The integration key Bee uses at runtime is deliberately NOT an administrator, so app deployment needs its own
// credential. Keep this key on the operator's machine only; revoke it in Twenty (Settings → APIs) when done.
//   TWENTY_URL=… TWENTY_ADMIN_EMAIL=… TWENTY_ADMIN_PASSWORD=… node scripts/twenty-deploy-key.mjs [days=30]
const base = (process.env.TWENTY_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const email = process.env.TWENTY_ADMIN_EMAIL ?? 'admin@crmbee.local';
const password = process.env.TWENTY_ADMIN_PASSWORD;
const days = Number(process.argv[2] ?? 30);
if (!password) { console.error('TWENTY_ADMIN_PASSWORD is required'); process.exit(1); }
const gql = async (query, variables, token) => {
  const r = await fetch(`${base}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
};
const lt = (await gql(`mutation($e:String!,$p:String!){getLoginTokenFromCredentials(email:$e,password:$p,origin:"${base}"){loginToken{token}}}`, { e: email, p: password })).getLoginTokenFromCredentials.loginToken.token;
const access = (await gql(`mutation($t:String!){getAuthTokensFromLoginToken(loginToken:$t,origin:"${base}"){tokens{accessOrWorkspaceAgnosticToken{token}}}}`, { t: lt })).getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
const admin = (await gql(`{ getRoles { id label } }`, {}, access)).getRoles.find((r) => r.label === 'Admin');
const exp = new Date(Date.now() + days * 86_400_000).toISOString();
const key = (await gql(`mutation($i:CreateApiKeyInput!){createApiKey(input:$i){id}}`, { i: { name: `bee-deploy-${new Date().toISOString().slice(0, 10)}`, expiresAt: exp, roleId: admin.id } }, access)).createApiKey;
const tok = (await gql(`mutation($id:UUID!,$exp:String!){generateApiKeyToken(apiKeyId:$id,expiresAt:$exp){token}}`, { id: key.id, exp }, access)).generateApiKeyToken.token;
console.log(tok);
