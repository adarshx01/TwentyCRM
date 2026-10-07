#!/usr/bin/env node
// Create (or re-check) the Bee service user in a client's Twenty workspace — an Admin seat Bee signs in as ONLY to
// assign members' Twenty roles and keep workspace settings hardened (Twenty refuses both to API keys).
// Generate the password first and store it in the secret manager, then:
//   TWENTY_URL=… TWENTY_ADMIN_EMAIL=… TWENTY_ADMIN_PASSWORD=… BEE_SERVICE_EMAIL=bee-service@client.example BEE_SERVICE_PASSWORD=… \
//     node scripts/twenty-service-user.mjs
// Then reference it in the tenant manifest: "twenty": { …, "serviceUser": { "email": "…", "passwordRef": "env:…" } }.
const base = (process.env.TWENTY_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const { TWENTY_ADMIN_EMAIL: adminEmail = 'admin@crmbee.local', TWENTY_ADMIN_PASSWORD: adminPassword, BEE_SERVICE_EMAIL: email, BEE_SERVICE_PASSWORD: password } = process.env;
if (!adminPassword || !email || !password) { console.error('TWENTY_ADMIN_PASSWORD, BEE_SERVICE_EMAIL and BEE_SERVICE_PASSWORD are required'); process.exit(1); }
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
const ws = (await gql(`{ currentWorkspace { id inviteHash isPublicInviteLinkEnabled } }`, {}, admin)).currentWorkspace;
let existing = true;
try { await session(email, password); } catch { existing = false; }
if (!existing) {
  // The public invite link is opened only for this sign-up and closed again immediately.
  await gql(`mutation($d: UpdateWorkspaceInput!) { updateWorkspace(data: $d) { id } }`, { d: { isPublicInviteLinkEnabled: true } }, admin);
  try {
    await gql(`mutation($e:String!,$p:String!,$h:String,$w:UUID){ signUpInWorkspace(email:$e,password:$p,workspaceInviteHash:$h,workspaceId:$w){ loginToken { token } } }`, { e: email, p: password, h: ws.inviteHash, w: ws.id });
  } finally {
    await gql(`mutation($d: UpdateWorkspaceInput!) { updateWorkspace(data: $d) { id } }`, { d: { isPublicInviteLinkEnabled: false } }, admin);
  }
}
const roles = (await gql(`{ getRoles { id label workspaceMembers { id userEmail } } }`, {}, admin)).getRoles;
const adminRole = roles.find((r) => r.label === 'Admin');
const me = roles.flatMap((r) => r.workspaceMembers).find((m) => m.userEmail?.toLowerCase() === email.toLowerCase());
if (!me) throw new Error('service user is not a member of this workspace');
if (!adminRole.workspaceMembers.some((m) => m.id === me.id)) await gql(`mutation($m: UUID!, $r: UUID!) { updateWorkspaceMemberRole(workspaceMemberId: $m, roleId: $r) { id } }`, { m: me.id, r: adminRole.id }, admin);
console.log(JSON.stringify({ workspaceId: ws.id, serviceUser: email, memberId: me.id, created: !existing, role: 'Admin' }));
