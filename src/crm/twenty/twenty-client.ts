import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import type { TenantContext } from '../../common/types';
import { SECRET_RESOLVER, type SecretResolver } from '../../secrets/secret-resolver';
import { WorkspaceLimiter } from '../../ratelimit/workspace-limiter';
import { RetryLaterError } from '../../common/errors';
import { CrmPermanentError, CrmTransientError } from '../crm-adapter.interface';
import { M } from '../../observability/metrics';
import { getLogger } from '../../observability/logger';

export const FETCH_FN = 'FETCH_FN';

export interface TwentyRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface ListResult {
  records: any[];
  truncated: boolean;
  total?: number;
}

/**
 * Workspace-scoped HTTP client for Twenty (SYNC-04, TEN-04).
 *  - per-workspace token from the secret manager (never stored in the DB)
 *  - request budget + Retry-After handling
 *  - bounded timeouts; connection errors on writes are retried only after the
 *    caller has checked the operation key (see TwentyAdapter.create*)
 */
@Injectable()
export class TwentyClient {
  private readonly log = getLogger('twenty-client');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
    private readonly limiter: WorkspaceLimiter,
    @Inject(FETCH_FN) private readonly fetchFn: typeof fetch,
  ) {}

  async request(ctx: TenantContext, req: TwentyRequest): Promise<any> {
    await this.limiter.takeRequest(ctx.twentyWorkspaceId);
    const token = await this.secrets.resolve(ctx.twentyApiTokenRef);
    const base = (ctx.twentyBaseUrl ?? this.config.twenty.apiUrl).replace(/\/$/, '');
    const url = new URL(`${base}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const label = { workspace: ctx.twentyWorkspaceId, method: req.method };

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: req.method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(this.config.twenty.timeoutMs),
      });
    } catch (e) {
      M.twentyCalls().inc({ ...label, status: 'network_error' });
      throw new CrmTransientError(`Twenty request failed: ${(e as Error).name}`);
    }
    M.twentyCalls().inc({ ...label, status: String(res.status) });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 30;
      throw new RetryLaterError(retryAfter * 1000 + Math.floor(Math.random() * 1000), 'twenty_429');
    }
    if (res.status >= 500 || res.status === 408) throw new CrmTransientError(`Twenty returned ${res.status}`, res.status);
    if (res.status === 204) return null;

    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (res.status >= 400) {
      const msg = json?.messages?.[0] ?? json?.message ?? json?.error ?? `HTTP ${res.status}`;
      this.log.warn({ status: res.status, path: req.path }, 'twenty rejected request');
      throw new CrmPermanentError(`Twenty rejected the request: ${String(msg).slice(0, 200)}`, res.status);
    }
    return json;
  }

  /** Follow cursor pagination until exhausted or `max` records (SUM-03: caller discloses truncation). */
  async listAll(ctx: TenantContext, path: string, filter?: string, opts: { max?: number; pageSize?: number } = {}): Promise<ListResult> {
    const max = opts.max ?? 10_000;
    const pageSize = Math.min(opts.pageSize ?? 60, 60);
    const records: any[] = [];
    let cursor: string | undefined;
    let total: number | undefined;
    for (;;) {
      const json = await this.request(ctx, { method: 'GET', path, query: { filter, limit: pageSize, starting_after: cursor } });
      const page = firstDataValue(json) as any[];
      total = json?.totalCount ?? total;
      for (const r of page ?? []) records.push(r);
      const info = json?.pageInfo;
      if (!info?.hasNextPage || !info?.endCursor) return { records, truncated: false, total };
      if (records.length >= max) return { records: records.slice(0, max), truncated: true, total };
      cursor = info.endCursor;
    }
  }
}

/** Twenty wraps payloads as { data: { <name>: payload } }. */
export function firstDataValue(json: any): unknown {
  const data = json?.data;
  if (!data || typeof data !== 'object') return undefined;
  const keys = Object.keys(data);
  return keys.length ? data[keys[0]] : undefined;
}
