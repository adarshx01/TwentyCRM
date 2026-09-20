import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { verifyTwentyWebhookSignature } from '../common/webhook-signature';
import { loadConfig } from '../config/app.config';
import { OutreachService } from './outreach.service';

@Controller('internal/twenty')
export class WebhookController {
  private readonly log = new Logger(WebhookController.name);

  constructor(private readonly outreach: OutreachService) {}

  @Post('webhook')
  @HttpCode(202)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-twenty-webhook-signature') signature?: string,
    @Headers('x-twenty-webhook-timestamp') timestamp?: string,
  ) {
    const cfg = loadConfig();
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (cfg.twentyWebhookSecret) {
      const ok = verifyTwentyWebhookSignature({
        secret: cfg.twentyWebhookSecret,
        timestamp,
        signature,
        rawBody: raw,
      });
      if (!ok) {
        throw new UnauthorizedException('Invalid Twenty webhook signature');
      }
    } else {
      this.log.warn('TWENTY_WEBHOOK_SECRET is empty; accepting webhook without verification');
    }

    let payload: { event?: string; data?: { id?: string; stage?: string } };
    try {
      payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    } catch {
      payload = (req.body ?? {}) as { event?: string; data?: { id?: string } };
    }

    const event = payload.event ?? '';
    const id = payload.data?.id;
    if (!id) {
      return { ignored: true, reason: 'no id' };
    }

    if (event.startsWith('opportunity.')) {
      await this.outreach.enqueue({ opportunityId: id, source: 'webhook' });
      return { queued: true, opportunityId: id };
    }

    return { ignored: true, event };
  }
}
