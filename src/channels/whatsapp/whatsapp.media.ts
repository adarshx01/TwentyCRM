import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { FETCH_FN } from '../../crm/twenty/twenty-client';
import { SafeFetcher } from '../../media/safe-fetch';
import { UserFacingError } from '../../common/errors';
import type { MediaFetcher } from '../channel.types';
import { MAX_AUDIO_SIZE } from '../../common/utils/sanitize.util';

/** Downloads WhatsApp media by ID with the platform token; only Meta hosts are allowed (SEC-01). */
@Injectable()
export class WhatsAppMediaFetcher implements MediaFetcher {
  private readonly safe: SafeFetcher;
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig, @Inject(FETCH_FN) private readonly fetchFn: typeof fetch) {
    this.safe = new SafeFetcher(config.media.allowedHosts, fetchFn);
  }

  async fetch(d: { mediaId: string; mimeType: string; size?: number }) {
    const wa = this.config.whatsapp;
    if (!wa) throw new UserFacingError('WhatsApp is not configured.');
    if (!/^[0-9A-Za-z_-]{3,100}$/.test(d.mediaId)) throw new UserFacingError('That attachment could not be read.');
    const metaUrl = `https://graph.facebook.com/${wa.graphVersion}/${d.mediaId}`;
    const metaRes = await this.safe.download(metaUrl, { maxBytes: 64 * 1024, headers: { Authorization: `Bearer ${wa.accessToken}` }, timeoutMs: 10_000 });
    const meta = JSON.parse(metaRes.data.toString('utf8')) as { url?: string; mime_type?: string };
    if (!meta.url) throw new UserFacingError('That attachment could not be downloaded.');
    const { data } = await this.safe.download(meta.url, { maxBytes: MAX_AUDIO_SIZE, headers: { Authorization: `Bearer ${wa.accessToken}` } });
    return { data, mimeType: meta.mime_type };
  }
}
