import { BadRequestException, Body, Controller, HttpCode, Inject, NotFoundException, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Public, Webhook } from '../common/decorators';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { DbService } from '../database/db.service';
import { intakeSources } from '../database/schema';
import { IntakeService } from '../intake/intake.service';
import { SECRET_RESOLVER, type SecretResolver } from '../secrets/secret-resolver';
import { M } from '../observability/metrics';

type RawReq = FastifyRequest & { rawBody?: Buffer };

const EmailEnvelope = z.object({
  eventId: z.string().min(1).max(512),
  recipient: z.string().email(),
  rawEmailBase64: z.string().min(1).max(20_000_000),
  receivedAt: z.string().datetime().optional(),
  auth: z.record(z.unknown()).optional(),
}).strict();

const FormEvent = z.object({ submissionId: z.string().max(512).optional(), submittedAt: z.string().datetime().optional(), fields: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])) }).strict();

const sig = (secret: string, raw: Buffer) => createHmac('sha256', secret).update(raw).digest('hex');
const eq2 = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Inbound form-email and form-event endpoints (§16–18). Authenticate (HMAC over the raw
 * body) → durably record → acknowledge. Tenant and source come from the authenticated
 * recipient / registered source, never from message content.
 */
@Controller('intake')
export class IntakeWebhookController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly intake: IntakeService,
    private readonly db: DbService,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
  ) {}

  @Public() @Webhook() @Post('email/:provider') @HttpCode(202)
  async email(@Req() req: RawReq, @Param('provider') provider: string, @Body() body: unknown) {
    const secret = this.config.email.webhookSecrets[provider];
    const given = String(req.headers['x-signature'] ?? '').replace(/^sha256=/, '');
    if (!secret || !req.rawBody || !eq2(sig(secret, req.rawBody), given)) {
      M.webhookAuthFailures().inc({ channel: 'email', reason: 'signature' });
      throw new UnauthorizedException('invalid signature');
    }
    const env = EmailEnvelope.parse(body);
    const raw = Buffer.from(env.rawEmailBase64, 'base64');
    if (raw.length === 0 || raw.length > 15 * 1024 * 1024) throw new BadRequestException('invalid message size');
    return this.intake.receiveEmail({ eventId: env.eventId, recipient: env.recipient, raw, receivedAt: env.receivedAt, auth: env.auth });
  }

  @Public() @Webhook() @Post('forms/:sourceId') @HttpCode(202)
  async form(@Req() req: RawReq, @Param('sourceId') sourceId: string, @Body() body: unknown) {
    const [src] = await this.db.systemTx((tx) => tx.select().from(intakeSources).where(eq(intakeSources.sourceId, sourceId)));
    // Same response for unknown source and bad signature: no source enumeration.
    const secret = src?.webhookSecretRef && src.status === 'active' ? await this.secrets.resolve(src.webhookSecretRef).catch(() => null) : null;
    const given = String(req.headers['x-signature'] ?? '').replace(/^sha256=/, '');
    if (!src || !secret || !req.rawBody || !eq2(sig(secret, req.rawBody), given)) {
      M.webhookAuthFailures().inc({ channel: 'form', reason: 'signature' });
      throw new UnauthorizedException('invalid signature');
    }
    if (src.type !== 'webhook') throw new NotFoundException();
    return this.intake.receiveForm(src, FormEvent.parse(body));
  }
}
