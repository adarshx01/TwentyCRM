import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { Public, Webhook } from '../common/decorators';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { verifyWhatsAppSignature } from '../common/utils/crypto.util';
import { normalizeWhatsApp } from '../channels/whatsapp/whatsapp.normalizer';
import { normalizeTeams } from '../channels/teams/teams.normalizer';
import { TEAMS_VERIFIER, type TeamsTokenVerifier } from '../channels/teams/teams.service';
import { InboundService } from './inbound.service';
import { OutboundService } from '../outbound/outbound.service';
import { DbService } from '../database/db.service';
import { channelBindings } from '../database/schema';
import { M } from '../observability/metrics';
import { timingSafeEqual } from 'node:crypto';
import { getLogger } from '../observability/logger';
import { QueueService } from '../queue/queue.service';
import { QUEUES, type ReconcileJob } from '../queue/queues';
import { SECRET_RESOLVER, type SecretResolver } from '../secrets/secret-resolver';
import { tenants } from '../database/schema';
import { createHmac } from 'node:crypto';

type RawReq = FastifyRequest & { rawBody?: Buffer };

/**
 * Channel webhooks. Every handler: authenticate the provider → normalize → persist &
 * enqueue → acknowledge. No business logic and no tenant decisions happen here (TEN-01).
 */
@Controller('webhooks')
export class WebhooksController {
  private readonly log = getLogger('webhooks');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly inbound: InboundService,
    private readonly outbound: OutboundService,
    private readonly db: DbService,
    private readonly queue: QueueService,
    @Inject(SECRET_RESOLVER) private readonly secrets: SecretResolver,
    @Inject(TEAMS_VERIFIER) private readonly teamsVerifier: TeamsTokenVerifier | null,
  ) {}

  // ── WhatsApp ────────────────────────────────────────────────
  @Public() @Webhook() @Get('whatsapp')
  verifyWhatsApp(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res() reply: FastifyReply) {
    const expected = this.config.whatsapp?.verifyToken;
    const ok = !!expected && mode === 'subscribe' && typeof token === 'string' && token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!ok) { M.webhookAuthFailures().inc({ channel: 'whatsapp', reason: 'verify_token' }); return reply.status(403).send({ error: 'forbidden' }); }
    return reply.status(200).type('text/plain').send(challenge);
  }

  @Public() @Webhook() @Post('whatsapp') @HttpCode(200)
  async whatsapp(@Req() req: RawReq, @Body() body: unknown) {
    const end = M.webhookDuration().startTimer({ channel: 'whatsapp' });
    const wa = this.config.whatsapp;
    const sig = req.headers['x-hub-signature-256'];
    if (!wa || typeof sig !== 'string' || !req.rawBody || !verifyWhatsAppSignature(req.rawBody, sig, wa.appSecret)) {
      M.webhookAuthFailures().inc({ channel: 'whatsapp', reason: 'signature' });
      throw new UnauthorizedException('invalid signature');
    }
    const { events, statuses } = normalizeWhatsApp(body);
    for (const s of statuses) {
      // Delivery receipts are handled separately from messages and never reported as business events.
      await this.outbound.applyReceipt(s.id, s.status, s.error ? { code: `wa_${s.error.code}`, message: s.error.message } : undefined);
      if (s.status === 'failed' && s.error?.code === 131050) await this.markOptedOut(s.recipient);
    }
    let accepted = 0; let dup = 0;
    for (const e of events) {
      if ((await this.inbound.accept(e)) === 'accepted') accepted++;
      else dup++;
    }
    M.webhookReceived().inc({ channel: 'whatsapp', outcome: 'ok' }, events.length || 1);
    end();
    return { ok: true, accepted, duplicates: dup };
  }

  private async markOptedOut(recipient?: string): Promise<void> {
    if (!recipient) return;
    await this.db.systemTx((tx) => tx.update(channelBindings).set({ optedOut: true }).where(and(eq(channelBindings.channel, 'whatsapp'), eq(channelBindings.externalId, `+${recipient.replace(/^\+/, '')}`))));
  }

  // ── Twenty change events (SYNC-02) ─────────────────────────
  /**
   * A signed Twenty webhook is only a hint that something changed: the payload is NOT trusted for data.
   * It triggers an immediate reconciliation of that workspace, which re-fetches records from Twenty. The
   * 5-minute scheduled reconciliation still covers missed events and native UI edits.
   */
  @Public() @Webhook() @Post('twenty/:slug') @HttpCode(202)
  async twenty(@Req() req: RawReq, @Param('slug') slug: string) {
    const [t] = await this.db.db.select().from(tenants).where(eq(tenants.slug, slug));
    const ref = t?.settings?.twentyWebhookSecretRef;
    const secret = ref ? await this.secrets.resolve(ref).catch(() => null) : null;
    const ts = String(req.headers['x-twenty-webhook-timestamp'] ?? '');
    const given = String(req.headers['x-twenty-webhook-signature'] ?? '');
    const fresh = /^\d{10,13}$/.test(ts) && Math.abs(Date.now() - Number(ts.length === 10 ? Number(ts) * 1000 : ts)) < 5 * 60_000;
    const ok = !!(t && secret && req.rawBody && fresh && given.length === 64 && timingSafeEqual(Buffer.from(given), Buffer.from(createHmac('sha256', secret).update(`${ts}:${req.rawBody.toString('utf8')}`).digest('hex'))));
    // Same response for unknown tenant and bad signature: no tenant enumeration.
    if (!ok) { M.webhookAuthFailures().inc({ channel: 'twenty', reason: 'signature' }); throw new UnauthorizedException('invalid signature'); }
    await this.queue.send(QUEUES.RECONCILIATION, { tenantId: t.id } satisfies ReconcileJob, { tenantId: t.id, idempotencyKey: `recon-hook:${t.id}:${Math.floor(Date.now() / 20_000)}` });
    M.webhookReceived().inc({ channel: 'twenty', outcome: 'ok' });
    return { ok: true };
  }

  // ── Teams ───────────────────────────────────────────────────
  @Public() @Webhook() @Post('teams') @HttpCode(200)
  async teams(@Req() req: RawReq, @Body() activity: any) {
    const end = M.webhookDuration().startTimer({ channel: 'teams' });
    if (!this.teamsVerifier || !(await this.teamsVerifier.verify(req.headers.authorization, activity ?? {}))) {
      M.webhookAuthFailures().inc({ channel: 'teams', reason: 'jwt' });
      throw new UnauthorizedException('invalid token');
    }
    const n = normalizeTeams(activity);
    if (n.lifecycle.kind === 'installed' || n.lifecycle.kind === 'uninstalled') await this.applyLifecycle(n.lifecycle, n.ref);
    if (n.event) {
      // Channel/group messages are ingested only when the bot is @mentioned, and never answered with data (TM-04).
      if (n.nonPersonal && !n.mentioned) { end(); return { ok: true, ignored: true }; }
      await this.inbound.accept(n.event);
    }
    M.webhookReceived().inc({ channel: 'teams', outcome: 'ok' });
    end();
    return { ok: true };
  }

  /** Install stores the conversation reference; uninstall clears it so sends fail cleanly (TM-02, AT-11). */
  private async applyLifecycle(l: { kind: 'installed' | 'uninstalled'; aadObjectId?: string } & Record<string, any>, ref?: any): Promise<void> {
    if (!l.aadObjectId) return;
    await this.db.systemTx((tx) =>
      tx.update(channelBindings).set({ conversationRef: l.kind === 'installed' ? (ref ?? l.ref) : null }).where(and(eq(channelBindings.channel, 'teams'), eq(channelBindings.connectionId, (l.kind === 'installed' ? (ref ?? l.ref).tenantId : l.tenantId)), eq(channelBindings.externalId, l.aadObjectId!))),
    );
  }
}
