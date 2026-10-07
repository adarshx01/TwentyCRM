import { defineLogicFunction } from 'twenty-sdk/define';
import type { RoutePayload } from 'twenty-sdk/logic-function';

import { API_FN_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { createBeeClient } from 'src/lib/bee-client';

type Call = { method?: string; path?: string; body?: unknown };

// Only these Bee routes can be reached from the page; Bee itself applies the caller's role to each of them.
const ALLOWED = /^\/v1\/(me|approvals|tenant-admin)(\/[A-Za-z0-9_\-/]*)?(\?[A-Za-z0-9_\-=&.%]*)?$/;

const handler = async (event: RoutePayload) => {
  const call = (event.body ?? {}) as Call;
  const method = String(call.method ?? 'GET').toUpperCase();
  const path = String(call.path ?? '');
  if (!['GET', 'POST', 'PATCH'].includes(method) || !ALLOWED.test(path) || path.includes('..')) {
    return { status: 400, data: { message: 'Unsupported Bee request.' } };
  }
  try {
    const bee = await createBeeClient();
    const r = await bee.request(method, path, method === 'GET' ? undefined : call.body ?? {});
    return { status: r.status, data: r.json };
  } catch (e) {
    return { status: 502, data: { message: e instanceof Error ? e.message : String(e) } };
  }
};

export default defineLogicFunction({
  universalIdentifier: API_FN_UNIVERSAL_IDENTIFIER,
  name: 'bee-api',
  description: 'Relays the Bee page (My Bee, Approvals, Administration) to the CRM Bee API as the signed-in member.',
  timeoutSeconds: 20,
  handler,
  httpRouteTriggerSettings: { path: '/bee/api', httpMethod: 'POST', isAuthRequired: true },
});
