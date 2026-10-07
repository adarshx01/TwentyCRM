import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { UserFacingError } from '../common/errors';

/** True for loopback, private, link-local and other non-public addresses (SSRF guard). */
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return m ? isPrivateAddress(m[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((rule) => {
    const r = rule.toLowerCase();
    return r.startsWith('*.') ? h.endsWith(r.slice(1)) && h.length > r.length - 1 : h === r;
  });
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/**
 * Fetch media only from allowlisted HTTPS hosts that resolve to public addresses.
 * Redirects are re-validated, bodies are size-capped while streaming, and the
 * system never fetches URLs found inside card text, emails or transcripts (SEC-01).
 */
export class SafeFetcher {
  constructor(
    private readonly allowedHosts: string[],
    private readonly fetchFn: typeof fetch = fetch,
    private readonly resolver: Resolver = defaultResolver,
  ) {}

  async assertSafe(url: string): Promise<URL> {
    let u: URL;
    try { u = new URL(url); } catch { throw new UserFacingError('That attachment link is not valid.', 'MEDIA_URL'); }
    if (u.protocol !== 'https:') throw new UserFacingError('That attachment link is not allowed.', 'MEDIA_URL');
    if (u.username || u.password) throw new UserFacingError('That attachment link is not allowed.', 'MEDIA_URL');
    if (isIP(u.hostname)) throw new UserFacingError('That attachment link is not allowed.', 'MEDIA_URL');
    if (!hostAllowed(u.hostname, this.allowedHosts)) throw new UserFacingError('That attachment source is not allowed.', 'MEDIA_HOST');
    const addrs = await this.resolver(u.hostname);
    if (!addrs.length || addrs.some(isPrivateAddress)) throw new UserFacingError('That attachment link is not allowed.', 'MEDIA_URL');
    return u;
  }

  async download(url: string, opts: { maxBytes: number; headers?: Record<string, string>; timeoutMs?: number }): Promise<{ data: Buffer; contentType?: string }> {
    let current = await this.assertSafe(url);
    for (let hop = 0; hop < 3; hop++) {
      const res = await this.fetchFn(current, { headers: opts.headers, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new UserFacingError('The attachment could not be downloaded.', 'MEDIA_FETCH');
        current = await this.assertSafe(new URL(loc, current).toString());
        // Credentials are only ever sent to the original host.
        opts = { ...opts, headers: current.hostname === new URL(url).hostname ? opts.headers : undefined };
        continue;
      }
      if (!res.ok) throw new UserFacingError('The attachment could not be downloaded.', 'MEDIA_FETCH');
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > opts.maxBytes) throw new UserFacingError('That file is too large.', 'MEDIA_SIZE');
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > opts.maxBytes) { await reader.cancel(); throw new UserFacingError('That file is too large.', 'MEDIA_SIZE'); }
        chunks.push(Buffer.from(value));
      }
      return { data: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? undefined };
    }
    throw new UserFacingError('The attachment could not be downloaded.', 'MEDIA_FETCH');
  }
}
