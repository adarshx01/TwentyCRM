import { readFileSync } from 'node:fs';

/** Resolves secret-manager references stored in the DB / manifests (CFG-03, SEC-01). */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}
export const SECRET_RESOLVER = 'SECRET_RESOLVER';

type FetchFn = typeof fetch;

/**
 * Supported reference schemes:
 *   env:NAME                          environment variable (Cloud Run / systemd credentials)
 *   file:/run/secrets/name            mounted file (Docker/K8s secrets)
 *   gcp-sm:projects/P/secrets/S/versions/V   GCP Secret Manager REST (uses the VM service account)
 */
export class DefaultSecretResolver implements SecretResolver {
  private cache = new Map<string, { value: string; expires: number }>();
  constructor(private readonly fetchFn: FetchFn = fetch, private readonly env: NodeJS.ProcessEnv = process.env, private readonly ttlMs = 5 * 60_000) {}

  async resolve(ref: string): Promise<string> {
    const cached = this.cache.get(ref);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = await this.load(ref);
    this.cache.set(ref, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  private async load(ref: string): Promise<string> {
    const idx = ref.indexOf(':');
    if (idx < 0) throw new Error('Invalid secret reference (missing scheme)');
    const scheme = ref.slice(0, idx);
    const target = ref.slice(idx + 1);
    switch (scheme) {
      case 'env': {
        const v = this.env[target];
        if (!v) throw new Error(`Secret env var ${target} is not set`);
        return v;
      }
      case 'file':
        return readFileSync(target, 'utf8').trim();
      case 'gcp-sm':
        return this.loadGcp(target);
      default:
        throw new Error(`Unsupported secret scheme: ${scheme}`);
    }
  }

  private async loadGcp(name: string): Promise<string> {
    const tokenRes = await this.fetchFn(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } },
    );
    if (!tokenRes.ok) throw new Error('Unable to obtain GCP access token');
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const res = await this.fetchFn(`https://secretmanager.googleapis.com/v1/${name}:access`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!res.ok) throw new Error(`Secret Manager returned ${res.status}`);
    const body = (await res.json()) as { payload: { data: string } };
    return Buffer.from(body.payload.data, 'base64').toString('utf8');
  }

  invalidate(ref?: string): void {
    if (ref) this.cache.delete(ref);
    else this.cache.clear();
  }
}
