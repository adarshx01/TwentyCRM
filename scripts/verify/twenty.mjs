// Tiny Twenty GraphQL/session helpers shared by the live verification scripts.
export const base = process.env.TWENTY_URL ?? 'http://localhost:3000';
export const gql = async (query, variables, token) => {
  const r = await fetch(`${base}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  return r.json();
};
export const session = async (email, password) => {
  const a = await gql(`mutation($e:String!,$p:String!){getLoginTokenFromCredentials(email:$e,password:$p,origin:"${base}"){loginToken{token}}}`, { e: email, p: password });
  if (a.errors) return { error: a.errors[0].message };
  const b = await gql(`mutation($t:String!){getAuthTokensFromLoginToken(loginToken:$t,origin:"${base}"){tokens{accessOrWorkspaceAgnosticToken{token}}}}`, { t: a.data.getLoginTokenFromCredentials.loginToken.token });
  if (b.errors) return { error: b.errors[0].message };
  return { token: b.data.getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token };
};
