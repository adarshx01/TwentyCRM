import { RestApiClient } from 'twenty-client-sdk/rest';

export type BeeMessage = { id: string; at: string; text: string; buttons?: Array<{ id: string; title: string }> };

/** Claims of the platform-minted app token. Twenty authenticated the caller before running us, so these are trustworthy. */
const callerClaims = (): { workspaceId: string; userId: string } => {
  const token = process.env.TWENTY_APP_ACCESS_TOKEN ?? '';
  const payload = token.split('.')[1];
  if (!payload) throw new Error('No app access token');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  const workspaceId = String(claims.workspaceId ?? '');
  const userId = String(claims.userId ?? '');
  if (!workspaceId || !userId) throw new Error('Bee needs a signed-in Twenty user');
  return { workspaceId, userId };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Talks to the CRM Bee API as the signed-in member. */
export const createBeeClient = async () => {
  const { workspaceId, userId } = callerClaims();
  const members = await new RestApiClient().get<{ data?: { workspaceMembers?: Array<{ userEmail?: string }> } }>('/rest/workspaceMembers', {
    query: { filter: `userId[eq]:${userId}`, limit: 1 },
  });
  const email = (members as { data?: { workspaceMembers?: Array<{ userEmail?: string }> } })?.data?.workspaceMembers?.[0]?.userEmail;
  if (!email) throw new Error('Could not identify your Twenty account.');

  const base = (process.env.BEE_API_URL ?? '').replace(/\/$/, '');
  const token = process.env.BEE_CHAT_TOKEN ?? '';
  if (!base || !token) throw new Error('CRM Bee is not configured (set BEE_API_URL and BEE_CHAT_TOKEN in the app settings).');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const who = { workspaceId, email };

  const request = async <T,>(path: string, init: RequestInit): Promise<T> => {
    const res = await fetch(`${base}/v1/crm-chat/${path}`, init);
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) throw new Error((json as { message?: string } | null)?.message ?? `Bee returned ${res.status}`);
    return json as T;
  };
  const poll = async (after?: string): Promise<BeeMessage[]> =>
    (await request<{ messages: BeeMessage[] }>(`messages?${new URLSearchParams({ ...who, ...(after ? { after } : {}) })}`, { method: 'GET', headers })).messages;

  /** Send, then wait for Bee's reply (it runs through a queue, so replies arrive asynchronously) until it goes quiet. */
  const converse = async (send: (cursor?: string) => Promise<unknown>, maxMs = 50_000): Promise<BeeMessage[]> => {
    const before = await poll();
    let cursor = before.length ? before[before.length - 1].id : undefined;
    await send(cursor);
    const got: BeeMessage[] = [];
    const deadline = Date.now() + maxMs;
    let quietSince = 0;
    while (Date.now() < deadline) {
      await sleep(1200);
      const fresh = await poll(cursor);
      if (fresh.length) { got.push(...fresh); cursor = fresh[fresh.length - 1].id; quietSince = Date.now(); continue; }
      if (got.length && Date.now() - quietSince > 3500) break;
    }
    return got;
  };

  return {
    sendText: (text: string) => converse(() => request('send', { method: 'POST', headers, body: JSON.stringify({ ...who, text: text.slice(0, 4000) }) })),
    pressButton: (id: string) => converse(() => request('button', { method: 'POST', headers, body: JSON.stringify({ ...who, id }) })),
  };
};
