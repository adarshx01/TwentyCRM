// Shared helpers for driving Twenty (multi-workspace) the way a browser session does.
export const gql = async (host, query, variables, token) => {
  const r = await fetch(`${host}/metadata`, { method: 'POST', headers: { 'content-type': 'application/json', origin: host, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  return r.json();
};
export const must = (r, w) => { if (r.errors?.length) throw new Error(`${w}: ${r.errors[0].message}`); return r.data; };
export const login = async (host, email, password) => {
  const a = must(await gql(host, `mutation($e:String!,$p:String!,$o:String!){ getLoginTokenFromCredentials(email:$e,password:$p,origin:$o){ loginToken{token} } }`, { e: email, p: password, o: host }), 'login');
  return must(await gql(host, `mutation($t:String!,$o:String!){ getAuthTokensFromLoginToken(loginToken:$t,origin:$o){ tokens{accessOrWorkspaceAgnosticToken{token}} } }`, { t: a.getLoginTokenFromCredentials.loginToken.token, o: host }), 'tokens').getAuthTokensFromLoginToken.tokens.accessOrWorkspaceAgnosticToken.token;
};
/** Call Bee through the app's relay function exactly as the Bee page does. */
export const bee = async (host, token, method, path, body) => {
  const r = await fetch(`${host}/s/bee/api`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method, path, body }) });
  const j = await r.json().catch(() => ({}));
  const rel = typeof j.status === 'number' ? j : j.data ?? j;
  return { status: rel.status ?? r.status, data: rel.data ?? rel };
};
