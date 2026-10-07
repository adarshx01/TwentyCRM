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

/** The function runs in the Twenty worker, where TWENTY_API_URL (localhost) is not reachable; use the configured internal URL. */
const twentyBaseUrl = (): string | undefined => (process.env.TWENTY_INTERNAL_URL || process.env.TWENTY_API_URL)?.replace(/\/$/, '');

const describe = (step: string, e: unknown): Error => {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  return new Error(`${step}: ${err?.message ?? e}${err?.cause ? ` (${err.cause.code ?? ''} ${err.cause.message ?? ''})` : ''}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls the CRM Bee API as the signed-in workspace member. Identity = (workspace id, member id) looked up from the
 * Twenty-authenticated user; the tenant's own app secret proves the call comes from this workspace's app. Bee then
 * requires the member to be LINKED to an active Bee user and applies that user's role and scope.
 */
export const createBeeClient = async () => {
  const { workspaceId, userId } = callerClaims();
  const members = await new RestApiClient({ baseUrl: twentyBaseUrl() }).get<{ data?: { workspaceMembers?: Array<{ id?: string }> } }>('/rest/workspaceMembers', {
    query: { filter: `userId[eq]:${userId}`, limit: 1 },
  }).catch((e) => { throw describe(`Twenty member lookup (${twentyBaseUrl() ?? 'no URL'})`, e); });
  const memberId = (members as { data?: { workspaceMembers?: Array<{ id?: string }> } })?.data?.workspaceMembers?.[0]?.id;
  if (!memberId) throw new Error('Could not identify your Twenty account.');

  const base = (process.env.BEE_API_URL ?? '').replace(/\/$/, '');
  const token = process.env.BEE_CHAT_TOKEN ?? '';
  if (!base || !token) throw new Error('CRM Bee is not configured for this workspace (BEE_API_URL / BEE_CHAT_TOKEN).');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-bee-workspace': workspaceId, 'x-bee-member': memberId };

  const request = async <T,>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).catch((e) => { throw describe(`Bee request ${base}`, e); });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, json: json as T };
  };
  const must = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await request<T>(method, path, body);
    if (r.status >= 400) throw new Error((r.json as { message?: string } | null)?.message ?? `Bee returned ${r.status}`);
    return r.json;
  };
  const poll = async (after?: string): Promise<BeeMessage[]> =>
    (await must<{ messages: BeeMessage[] }>('GET', `/v1/crm-chat/messages${after ? `?${new URLSearchParams({ after })}` : ''}`)).messages;

  /** Send, then wait for Bee's reply (it runs through a queue, so replies arrive asynchronously) until it goes quiet. */
  const converse = async (send: () => Promise<unknown>, maxMs = 50_000): Promise<BeeMessage[]> => {
    const before = await poll();
    let cursor = before.length ? before[before.length - 1].id : undefined;
    await send();
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
    sendText: (text: string) => converse(() => must('POST', '/v1/crm-chat/send', { text: text.slice(0, 4000) })),
    /** Raw relay for the Bee pages (status + JSON are passed back to the page). */
    request,
  };
};
