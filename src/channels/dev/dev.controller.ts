import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Public, Webhook } from '../../common/decorators';
import { InboundService } from '../../webhooks/inbound.service';
import { STORAGE, type StorageProvider } from '../../media/storage';
import { DevChannel } from './dev.channel';
import { DEV_CHAT_HTML } from './dev.ui';

const Phone = z.string().regex(/^\+\d{8,15}$/);
const Send = z.object({ phone: Phone, text: z.string().min(1).max(4000), replyToId: z.string().max(100).optional() }).strict();
const Button = z.object({ phone: Phone, id: z.string().max(300) }).strict();
const Upload = z.object({ phone: Phone, kind: z.enum(['image', 'audio']), mimeType: z.string().max(100), base64: z.string().max(30_000_000), filename: z.string().max(200).optional() }).strict();

/** Local development chat endpoints. They 404 unless DEV_CHANNEL=1 (and never run in production). */
@Controller('dev/chat')
export class DevController {
  constructor(
    private readonly dev: DevChannel,
    private readonly inbound: InboundService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  private guard(): void {
    if (!this.dev.enabled) throw new NotFoundException();
  }

  private event(phone: string, extra: Record<string, unknown>) {
    return { providerEventId: `dev.${randomUUID()}`, channel: 'dev' as const, connectionId: 'dev', externalSenderId: phone, conversationId: `dev:${phone}`, receivedAt: new Date().toISOString(), ...extra };
  }

  @Public() @Webhook() @Get()
  page(@Res() reply: FastifyReply) {
    this.guard();
    reply.header('content-security-policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'").type('text/html').send(DEV_CHAT_HTML);
  }

  @Public() @Webhook() @Post('send') @HttpCode(200)
  async send(@Body() body: unknown) {
    this.guard();
    const b = Send.parse(body);
    await this.inbound.accept(this.event(b.phone, { messageType: 'text', text: b.text, replyToId: b.replyToId }) as any);
    return { ok: true };
  }

  @Public() @Webhook() @Post('button') @HttpCode(200)
  async button(@Body() body: unknown) {
    this.guard();
    const b = Button.parse(body);
    await this.inbound.accept(this.event(b.phone, { messageType: 'interactive', interactiveResponse: { type: 'button_reply', id: b.id } }) as any);
    return { ok: true };
  }

  @Public() @Webhook() @Post('upload') @HttpCode(200)
  async upload(@Body() body: unknown) {
    this.guard();
    const b = Upload.parse(body);
    const mediaId = `dev/${randomUUID()}`;
    await this.storage.put(mediaId, Buffer.from(b.base64, 'base64'), b.mimeType);
    await this.inbound.accept(this.event(b.phone, { messageType: b.kind, media: [{ mediaId, mimeType: b.mimeType, filename: b.filename }] }) as any);
    return { ok: true };
  }

  @Public() @Webhook() @Get('messages')
  async messages(@Query('phone') phone: string, @Query('after') after?: string) {
    this.guard();
    return { messages: await this.dev.list(Phone.parse(phone), after) };
  }
}
