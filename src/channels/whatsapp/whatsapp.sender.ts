import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { FETCH_FN } from '../../crm/twenty/twenty-client';
import type { ChannelSender, OutboundContent, SendResult, SendTarget } from '../channel.types';
import { M } from '../../observability/metrics';
import { TenantService } from '../../tenant/tenant.service';
import { SECRET_RESOLVER, type SecretResolver } from '../../secrets/secret-resolver';

/** Meta error codes that are definitive refusals (never retried) — AT-10. */
const REJECTED_CODES = new Set([131026, 131047, 131048, 131049, 131051, 131052, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 131009, 100]);

/** WhatsApp Cloud API sender (WA-01..03). Only employee numbers from enrolled bindings reach here. */
@Injectable()
export class WhatsAppSender implements ChannelSender {
  readonly channel = 'whatsapp' as const;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FETCH_FN) private readonly fetchFn: typeof fetch,
    private readonly tenants: TenantService,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
  ) {}

  static body(content: OutboundContent, to: string, templateLanguage: string): Record<string, unknown> {
    const common = { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, '') };
    if (content.kind === 'template') {
      return { ...common, type: 'template', template: { name: content.name, language: { code: templateLanguage }, components: content.params.length ? [{ type: 'body', parameters: content.params.map((p) => ({ type: 'text', text: p })) }] : undefined } };
    }
    const text = content.text.slice(0, 4000);
    if (content.buttons?.length) {
      // WhatsApp allows at most 3 reply buttons with titles ≤ 20 characters.
      return { ...common, type: 'interactive', interactive: { type: 'button', body: { text: text.slice(0, 1024) }, action: { buttons: content.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) } } };
    }
    return { ...common, type: 'text', text: { body: text, preview_url: false } };
  }

  async send(target: SendTarget, content: OutboundContent): Promise<SendResult> {
    const wa = this.config.whatsapp;
    if (!wa) return { kind: 'rejected', code: 'channel_unavailable', message: 'whatsapp not configured' };
    const url = `https://graph.facebook.com/${wa.graphVersion}/${target.connectionId || wa.phoneNumberId}/messages`;
    // A client with a dedicated number may carry its own token; everyone else uses the platform number's.
    let token = wa.accessToken;
    if (target.tenantId) {
      try {
        const ref = (await this.tenants.getContext(target.tenantId)).settings.whatsappAccessTokenRef;
        if (ref) token = await this.secrets.resolve(ref);
      } catch { return { kind: 'retryable', message: 'could not resolve the WhatsApp credential', retryAfterMs: 30_000 }; }
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(WhatsAppSender.body(content, target.externalId, wa.templateLanguage)), signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      // The request may have been accepted before the connection broke: do not blindly retry.
      return { kind: 'ambiguous', message: `no response from WhatsApp (${(e as Error).name})` };
    }
    const json: any = await res.json().catch(() => ({}));
    if (res.ok && json?.messages?.[0]?.id) { M.channelHealth().set({ channel: 'whatsapp' }, 1); return { kind: 'sent', externalId: String(json.messages[0].id) }; }
    const code: number = json?.error?.code ?? res.status;
    const message = String(json?.error?.message ?? `HTTP ${res.status}`).slice(0, 200);
    if (res.status === 401 || code === 190) { M.channelHealth().set({ channel: 'whatsapp' }, 0); return { kind: 'retryable', message: 'whatsapp access token invalid or expired', retryAfterMs: 60_000 }; }
    if (res.status === 429 || code === 4 || code === 80007 || code === 130429) return { kind: 'retryable', message, retryAfterMs: 30_000 };
    if (res.status >= 500) return { kind: 'retryable', message };
    if (REJECTED_CODES.has(code) || res.status >= 400) return { kind: 'rejected', code: `wa_${code}`, message };
    return { kind: 'retryable', message };
  }
}
