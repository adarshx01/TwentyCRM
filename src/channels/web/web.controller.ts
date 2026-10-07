import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Post, Query, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Headers } from '@nestjs/common';
import { Public, Webhook } from '../../common/decorators';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { IdentityService } from '../../identity/identity.service';
import { InboundService } from '../../webhooks/inbound.service';
import { STORAGE, type StorageProvider } from '../../media/storage';
import { WebChannel } from './web.channel';

const Who = { workspaceId: z.string().min(1).max(100), email: z.string().email().max(255) };
const Send = z.object({ ...Who, text: z.string().min(1).max(4000), replyToId: z.string().max(100).optional() }).strict();
const Button = z.object({ ...Who, id: z.string().max(300) }).strict();
const Upload = z.object({ ...Who, kind: z.enum(['image', 'audio']), mimeType: z.string().max(100), base64: z.string().max(30_000_000), filename: z.string().max(200).optional() }).strict();
const Poll = z.object({ ...Who, after: z.string().max(100).optional() });

/**
 * Backend for the Bee app inside Twenty. The app's server-side logic function calls these routes with the shared
 * CRM_CHAT_TOKEN and vouches for the Twenty workspace and the member's email; nothing else is trusted from the body.
 */
@Controller('v1/crm-chat')
export class WebChatController {
  constructor(
    private readonly web: WebChannel,
    private readonly identity: IdentityService,
    private readonly inbound: InboundService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  private auth(header?: string): void {
    const token = this.config.web.token;
    if (!token) throw new NotFoundException();
    const got = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(token);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new UnauthorizedException();
  }

  /** Verify the member belongs to a provisioned tenant and return the stable conversation key. */
  private async who(b: { workspaceId: string; email: string }): Promise<string> {
    const externalId = `${b.workspaceId}:${b.email.trim().toLowerCase()}`;
    const bound = await this.identity.bindTrusted({ twentyWorkspaceId: b.workspaceId, email: b.email, channel: 'web', connectionId: 'web', externalId });
    if (!bound) throw new UnauthorizedException('This Twenty user is not enrolled in Bee. Ask an admin to add you.');
    return externalId;
  }

  private event(externalId: string, extra: Record<string, unknown>) {
    return { providerEventId: `web.${randomUUID()}`, channel: 'web' as const, connectionId: 'web', externalSenderId: externalId, conversationId: `web:${externalId}`, receivedAt: new Date().toISOString(), ...extra };
  }

  @Public() @Webhook() @Post('send') @HttpCode(200)
  async send(@Headers('authorization') a: string | undefined, @Body() body: unknown) {
    this.auth(a);
    const b = Send.parse(body);
    await this.inbound.accept(this.event(await this.who(b), { messageType: 'text', text: b.text, replyToId: b.replyToId }) as any);
    return { ok: true };
  }

  @Public() @Webhook() @Post('button') @HttpCode(200)
  async button(@Headers('authorization') a: string | undefined, @Body() body: unknown) {
    this.auth(a);
    const b = Button.parse(body);
    await this.inbound.accept(this.event(await this.who(b), { messageType: 'interactive', interactiveResponse: { type: 'button_reply', id: b.id } }) as any);
    return { ok: true };
  }

  @Public() @Webhook() @Post('upload') @HttpCode(200)
  async upload(@Headers('authorization') a: string | undefined, @Body() body: unknown) {
    this.auth(a);
    const b = Upload.parse(body);
    const externalId = await this.who(b);
    const mediaId = `web/${randomUUID()}`;
    await this.storage.put(mediaId, Buffer.from(b.base64, 'base64'), b.mimeType);
    await this.inbound.accept(this.event(externalId, { messageType: b.kind, media: [{ mediaId, mimeType: b.mimeType, filename: b.filename }] }) as any);
    return { ok: true };
  }

  @Public() @Webhook() @Get('messages')
  async messages(@Headers('authorization') a: string | undefined, @Query() q: unknown) {
    this.auth(a);
    const p = Poll.parse(q);
    const externalId = await this.who(p);
    return { messages: await this.web.list(externalId, p.after) };
  }
}
