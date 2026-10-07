import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { FETCH_FN } from '../../crm/twenty/twenty-client';
import { SafeFetcher } from '../../media/safe-fetch';
import { UserFacingError } from '../../common/errors';
import { MAX_AUDIO_SIZE } from '../../common/utils/sanitize.util';
import type { ChannelSender, MediaFetcher, OutboundContent, SendResult, SendTarget } from '../channel.types';
import { replyToCard, CARD_CONTENT_TYPE } from './adaptive-cards';
import type { TeamsConversationRef } from './teams.normalizer';
import { M } from '../../observability/metrics';

export const TEAMS_VERIFIER = 'TEAMS_VERIFIER';

/** Validates the Microsoft activity JWT (Bot Framework) — TM-02. */
export interface TeamsTokenVerifier {
  verify(authorization: string | undefined, activity: { serviceUrl?: string }): Promise<boolean>;
}

export class BotFrameworkVerifier implements TeamsTokenVerifier {
  private readonly jwks = createRemoteJWKSet(new URL('https://login.botframework.com/v1/.well-known/keys'));
  constructor(private readonly appId: string) {}
  async verify(authorization: string | undefined, activity: { serviceUrl?: string }): Promise<boolean> {
    if (!authorization?.startsWith('Bearer ')) return false;
    try {
      const { payload } = await jwtVerify(authorization.slice(7), this.jwks, { issuer: 'https://api.botframework.com', audience: this.appId, clockTolerance: 300 });
      // The token is bound to the service URL it may be answered on (prevents token replay to other hosts).
      const claim = payload['serviceurl'] as string | undefined;
      return !claim || !activity.serviceUrl || claim.replace(/\/$/, '') === activity.serviceUrl.replace(/\/$/, '');
    } catch { return false; }
  }
}

/** Client-credentials token for proactive/outbound bot calls. */
@Injectable()
export class TeamsTokenProvider {
  private cached?: { token: string; expires: number };
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, @Inject(FETCH_FN) private readonly fetchFn: typeof fetch) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.expires > Date.now() + 60_000) return this.cached.token;
    const t = this.config.teams;
    if (!t) throw new Error('teams not configured');
    // Multi-tenant bots authenticate against the botframework.com tenant; single-tenant bots use their own tenant.
    const authority = process.env.TEAMS_AUTH_TENANT ?? 'botframework.com';
    const res = await this.fetchFn(`https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: t.appId, client_secret: t.appPassword, scope: 'https://api.botframework.com/.default' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Teams token request failed (${res.status})`);
    const j: any = await res.json();
    this.cached = { token: j.access_token, expires: Date.now() + (j.expires_in ?? 3000) * 1000 };
    return this.cached.token;
  }
}

/** Teams sender: proactive messages use the stored conversation reference (TM-02). */
@Injectable()
export class TeamsSender implements ChannelSender {
  readonly channel = 'teams' as const;
  constructor(private readonly tokens: TeamsTokenProvider, @Inject(FETCH_FN) private readonly fetchFn: typeof fetch) {}

  async send(target: SendTarget, content: OutboundContent): Promise<SendResult> {
    const ref = target.conversationRef as TeamsConversationRef | null | undefined;
    if (!ref?.serviceUrl || !ref?.conversationId) return { kind: 'rejected', code: 'no_conversation_ref', message: 'the Teams app is not installed for this user (no conversation reference)' };
    if (!/^https:\/\/[a-z0-9.-]+\.(trafficmanager\.net|botframework\.com|teams\.microsoft\.com|skype\.com)\//i.test(ref.serviceUrl.endsWith('/') ? ref.serviceUrl : `${ref.serviceUrl}/`)) return { kind: 'rejected', code: 'bad_service_url', message: 'untrusted Teams service URL' };
    const reply = content.kind === 'template' ? { text: content.fallbackText } : content;
    const body: Record<string, unknown> = { type: 'message', text: reply.text.slice(0, 1000), attachments: [{ contentType: CARD_CONTENT_TYPE, content: replyToCard(reply as any) }] };
    let res: Response;
    try {
      const token = await this.tokens.get();
      res = await this.fetchFn(`${ref.serviceUrl.replace(/\/$/, '')}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      return { kind: 'ambiguous', message: `no response from Teams (${(e as Error).name})` };
    }
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) { M.channelHealth().set({ channel: 'teams' }, 1); return { kind: 'sent', externalId: String(json.id ?? `teams-${Date.now()}`) }; }
    if (res.status === 403 || res.status === 404) return { kind: 'rejected', code: 'teams_unavailable', message: 'the Teams app was uninstalled or the conversation no longer exists' };
    if (res.status === 429 || res.status >= 500) return { kind: 'retryable', message: `Teams returned ${res.status}`, retryAfterMs: Number(res.headers.get('retry-after') ?? 0) * 1000 || undefined };
    if (res.status === 401) { M.channelHealth().set({ channel: 'teams' }, 0); return { kind: 'retryable', message: 'Teams credentials rejected', retryAfterMs: 60_000 }; }
    return { kind: 'rejected', code: `teams_${res.status}`, message: String(json?.error?.message ?? `HTTP ${res.status}`).slice(0, 200) };
  }
}

/** Teams attachments: pre-authenticated download URLs (SharePoint/OneDrive) or bot-authenticated contentUrls. */
@Injectable()
export class TeamsMediaFetcher implements MediaFetcher {
  private readonly safe: SafeFetcher;
  constructor(@Inject(APP_CONFIG) config: AppConfig, private readonly tokens: TeamsTokenProvider, @Inject(FETCH_FN) fetchFn: typeof fetch) {
    this.safe = new SafeFetcher(config.media.allowedHosts, fetchFn);
  }
  async fetch(d: { mediaId: string; mimeType: string; url?: string }) {
    if (!d.url) throw new UserFacingError('That attachment could not be read.');
    const u = await this.safe.assertSafe(d.url);
    const headers = /trafficmanager\.net$|botframework\.com$/.test(u.hostname) ? { Authorization: `Bearer ${await this.tokens.get()}` } : undefined;
    const { data, contentType } = await this.safe.download(d.url, { maxBytes: MAX_AUDIO_SIZE, headers });
    return { data, mimeType: contentType?.split(';')[0] ?? d.mimeType };
  }
}
