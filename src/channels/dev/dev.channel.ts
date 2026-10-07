import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { STORAGE, type StorageProvider } from '../../media/storage';
import { UserFacingError } from '../../common/errors';
import type { ChannelSender, MediaFetcher, OutboundContent, SendResult, SendTarget } from '../channel.types';

export interface DevMessage {
  id: string;
  at: string;
  text: string;
  buttons?: Array<{ id: string; title: string }>;
  card?: unknown;
}


/**
 * Local development chat. Replies are appended to a per-phone Redis list so the API process (which serves the UI)
 * and the worker process (which sends replies) share them. It exists only when DEV_CHANNEL=1 and is refused in production.
 */
@Injectable()
export class DevChannel implements OnModuleDestroy {
  private redis?: Redis;
  readonly enabled: boolean;
  protected readonly prefix: string = 'dev';
  protected key(id: string): string { return `crmbee:${this.prefix}:msgs:${id}`; }

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.enabled = config.dev.channel && config.app.nodeEnv !== 'production';
  }

  protected r(): Redis {
    return (this.redis ??= new Redis(this.config.redis.url, { maxRetriesPerRequest: 2 }));
  }

  async push(phone: string, msg: Omit<DevMessage, 'id' | 'at'>): Promise<string> {
    const full: DevMessage = { id: randomUUID(), at: new Date().toISOString(), ...msg };
    const k = this.key(phone);
    await this.r().multi().rpush(k, JSON.stringify(full)).ltrim(k, -200, -1).expire(k, 86_400).exec();
    return full.id;
  }

  async list(phone: string, afterId?: string): Promise<DevMessage[]> {
    const all = (await this.r().lrange(this.key(phone), 0, -1)).map((s) => JSON.parse(s) as DevMessage);
    if (!afterId) return all;
    const i = all.findIndex((m) => m.id === afterId);
    return i < 0 ? all : all.slice(i + 1);
  }

  async onModuleDestroy(): Promise<void> {
    this.redis?.disconnect();
  }
}

export class DevSender implements ChannelSender {
  constructor(private readonly dev: DevChannel, readonly channel: 'dev' | 'web' = 'dev') {}

  async send(target: SendTarget, content: OutboundContent): Promise<SendResult> {
    const text = content.kind === 'template' ? `[template ${content.name}] ${content.fallbackText}` : content.text;
    const id = await this.dev.push(target.externalId, { text, ...(content.kind === 'reply' ? { buttons: content.buttons?.map((b) => ({ id: b.id, title: b.title })), card: content.card } : {}) });
    return { kind: 'sent', externalId: id };
  }
}

/** Uploads made through the dev UI are stored privately (tenant-less, under dev/) and fetched by the AI worker. */
export class DevMediaFetcher implements MediaFetcher {
  constructor(private readonly storage: StorageProvider) {}
  async fetch(d: { mediaId: string; mimeType: string }) {
    if (!/^(dev|web)\/[0-9a-f-]{36}$/.test(d.mediaId)) throw new UserFacingError('That attachment could not be read.');
    return { data: await this.storage.get(d.mediaId), mimeType: d.mimeType };
  }
}
export { STORAGE };
