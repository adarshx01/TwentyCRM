import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TwentyApp } from '../../common/decorators';
import type { Actor, TwentyCaller } from '../../common/guards/auth.guard';
import { IdentityService } from '../../identity/identity.service';
import { InboundService } from '../../webhooks/inbound.service';
import { STORAGE, type StorageProvider } from '../../media/storage';
import { WebChannel } from './web.channel';

const Send = z.object({ text: z.string().min(1).max(4000), replyToId: z.string().max(100).optional() }).strict();
const Button = z.object({ id: z.string().max(300) }).strict();
const Upload = z.object({ kind: z.enum(['image', 'audio']), mimeType: z.string().max(100), base64: z.string().max(30_000_000), filename: z.string().max(200).optional() }).strict();
const Poll = z.object({ after: z.string().max(100).optional() });

type Req = { actor?: Actor; twenty?: TwentyCaller };

/**
 * In-CRM chat (Ask AI › Bee inside Twenty). ActorGuard has already authenticated the tenant's app secret and resolved
 * the Twenty member to a LINKED, active user; the request body carries only the message.
 */
@Controller('v1/crm-chat')
@TwentyApp()
export class WebChatController {
  constructor(
    private readonly web: WebChannel,
    private readonly identity: IdentityService,
    private readonly inbound: InboundService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  /** Conversation key for this member in this workspace; the binding lets the normal pipeline resolve the user. */
  private async who(req: Req): Promise<{ externalId: string; actor: Actor }> {
    if (!req.actor || !req.twenty) throw new ForbiddenException('In-CRM chat is only available inside Twenty.');
    const externalId = `${req.twenty.workspaceId}:${req.twenty.memberId}`;
    await this.identity.bindTwentyMember(req.actor.tenant.tenantId, req.actor.user.userId, externalId);
    return { externalId, actor: req.actor };
  }

  private event(externalId: string, extra: Record<string, unknown>) {
    return { providerEventId: `web.${randomUUID()}`, channel: 'web' as const, connectionId: 'web', externalSenderId: externalId, conversationId: `web:${externalId}`, receivedAt: new Date().toISOString(), ...extra };
  }

  @Post('send') @HttpCode(200)
  async send(@Req() req: Req, @Body() body: unknown) {
    const b = Send.parse(body);
    const { externalId } = await this.who(req);
    await this.inbound.accept(this.event(externalId, { messageType: 'text', text: b.text, replyToId: b.replyToId }) as any);
    return { ok: true };
  }

  @Post('button') @HttpCode(200)
  async button(@Req() req: Req, @Body() body: unknown) {
    const b = Button.parse(body);
    const { externalId } = await this.who(req);
    await this.inbound.accept(this.event(externalId, { messageType: 'interactive', interactiveResponse: { type: 'button_reply', id: b.id } }) as any);
    return { ok: true };
  }

  @Post('upload') @HttpCode(200)
  async upload(@Req() req: Req, @Body() body: unknown) {
    const b = Upload.parse(body);
    const { externalId } = await this.who(req);
    const mediaId = `web/${randomUUID()}`;
    await this.storage.put(mediaId, Buffer.from(b.base64, 'base64'), b.mimeType);
    await this.inbound.accept(this.event(externalId, { messageType: b.kind, media: [{ mediaId, mimeType: b.mimeType, filename: b.filename }] }) as any);
    return { ok: true };
  }

  @Get('messages')
  async messages(@Req() req: Req, @Query() q: unknown) {
    const p = Poll.parse(q);
    const { externalId } = await this.who(req);
    return { messages: await this.web.list(externalId, p.after) };
  }
}
