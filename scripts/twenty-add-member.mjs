#!/usr/bin/env node
// Create a Twenty login for an employee and add it to a workspace (dev/test and onboarding helper). The workspace's
// public invite link is opened only for this sign-up and closed again immediately; the new member lands in the
// workspace's default role ("Bee · No access") until a client admin links them in Bee.
//   TWENTY_URL=… TWENTY_ADMIN_EMAIL=… TWENTY_ADMIN_PASSWORD=… MEMBER_EMAIL=… MEMBER_PASSWORD=… node scripts/twenty-add-member.mjs
const base = (process.env.TWENTY_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const { TWENTY_ADMIN_EMAIL: adminEmail = 'admin@crmbee.local', TWENTY_ADMIN_PASSWORD: adminPassword, MEMBER_EMAIL: email, MEMBER_PASSWORD: password } = process.env;
if (!adminPassword || !email || !password) { console.error('TWENTY_ADMIN_PASSWORD, MEMBER_EMAIL and MEMBER_PASSWORD are required'); process.exit(1); }
const gql = async (query, variables, token) => {
  const r = await fetch(`${base}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
};
const session = async (e, p) => {
  const lt = (await gql(`mutation($e:String!,$p:String!){getLoginTokenFromCredentials(email:$e,password:$p,origin:"${base}"){loginToken{token}}}`, { e, p })).getLoginTokenFromCredentials.loginToken.token;
  return (await gql(`mutation($t:String!){getAuthTokensFromLoginToken(loginToken:$t,origin:"${base}"){tokens{accessOrWorkspaceAgnosticToken{token}}}}`, { t: lt })).getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
};
const admin = await session(adminEmail, adminPassword);
let existed = true;
try { await session(email, password); } catch { existed = false; }
if (!existed) {
  const ws = (await gql(`{ currentWorkspace { id inviteHash } }`, {}, admin)).currentWorkspace;
  await gql(`mutation($d: UpdateWorkspaceInput!) { updateWorkspace(data: $d) { id } }`, { d: { isPublicInviteLinkEnabled: true } }, admin);
  try {
    await gql(`mutation($e:String!,$p:String!,$h:String,$w:UUID){ signUpInWorkspace(email:$e,password:$p,workspaceInviteHash:$h,workspaceId:$w){ loginToken { token } } }`, { e: email, p: password, h: ws.inviteHash, w: ws.id });
  } finally {
    await gql(`mutation($d: UpdateWorkspaceInput!) { updateWorkspace(data: $d) { id } }`, { d: { isPublicInviteLinkEnabled: false } }, admin);
  }
}
const roles = (await gql(`{ getRoles { label workspaceMembers { id userEmail } } }`, {}, admin)).getRoles;
const m = roles.flatMap((r) => r.workspaceMembers.map((x) => ({ ...x, role: r.label }))).find((x) => x.userEmail?.toLowerCase() === email.toLowerCase());
console.log(JSON.stringify({ email, created: !existed, memberId: m?.id ?? null, role: m?.role ?? null }));
