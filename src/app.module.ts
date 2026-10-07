import { Global, Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { APP_CONFIG, type AppConfig } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ActorGuard, AuthGuard } from './common/guards/auth.guard';
import { DefaultSecretResolver, SECRET_RESOLVER } from './secrets/secret-resolver';
import { LIMITER_BACKEND, MemoryLimiterBackend, RedisLimiterBackend } from './ratelimit/limiter';
import { WorkspaceLimiter } from './ratelimit/workspace-limiter';
import { QueueService } from './queue/queue.service';
import { AuditService } from './audit/audit.service';
import { TenantService } from './tenant/tenant.service';
import { QuotaService } from './tenant/quota.service';
import { IdentityService } from './identity/identity.service';
import { CRM_ADAPTER } from './crm/crm-adapter.interface';
import { TwentyAdapter } from './crm/twenty/twenty.adapter';
import { FETCH_FN, TwentyClient } from './crm/twenty/twenty-client';
import { ActionAuthorizer } from './crm/operations/action-authorizer';
import { StepExecutor } from './crm/operations/step-executor';
import { OperationEffects } from './crm/operations/operation-effects.service';
import { OperationJournal } from './crm/operations/operation-journal.service';
import { ReconciliationService } from './crm/reconciliation.service';
import { EXTRACTION_PROVIDER } from './extraction/extraction-provider.interface';
import { OpenAiProvider } from './extraction/openai.provider';
import { ExtractionService } from './extraction/extraction.service';
import { STORAGE, createStorage } from './media/storage';
import { SCANNER, createScanner } from './media/scanner';
import { MediaService } from './media/media.service';
import { CHANNEL_SENDERS, MEDIA_FETCHERS, type ChannelSenders, type MediaFetchers } from './channels/channel.types';
import { WhatsAppSender } from './channels/whatsapp/whatsapp.sender';
import { WhatsAppMediaFetcher } from './channels/whatsapp/whatsapp.media';
import { BotFrameworkVerifier, TEAMS_VERIFIER, TeamsMediaFetcher, TeamsSender, TeamsTokenProvider } from './channels/teams/teams.service';
import { OutboundService } from './outbound/outbound.service';
import { DraftService } from './conversation/draft.service';
import { ConfirmationService } from './conversation/confirmation.service';
import { DuplicateDetector } from './conversation/duplicate-detector.service';
import { MutationBuilder } from './conversation/mutation-builder';
import { ReplyService } from './conversation/reply.service';
import { ConversationService } from './conversation/conversation.service';
import { ReportsService } from './reports/reports.service';
import { SchedulePlanner } from './reminders/schedule-planner.service';
import { DigestService } from './reminders/digest.service';
import { SchedulerService } from './reminders/scheduler.service';
import { InboundService } from './webhooks/inbound.service';
import { IntakeService } from './intake/intake.service';
import { AssignmentService } from './intake/assignment.service';
import { GraphMailboxProvider, MAILBOX_PROVIDER, MailboxPoller } from './intake/mailbox.service';
import { MaintenanceService } from './maintenance/maintenance.service';
import { TenantProvisioningService } from './admin/tenant-provisioning.service';
import { WorkersService } from './workers/workers.service';
import { WebhooksController } from './webhooks/webhooks.controller';
import { ApiController } from './api/api.controller';
import { AdminController } from './admin/admin.controller';
import { IntakeWebhookController } from './api/intake-webhook.controller';
import { HealthController } from './health/health.controller';

/** Infrastructure providers (replaceable in tests by overriding the tokens). */
const infra: Provider[] = [
  { provide: FETCH_FN, useValue: fetch },
  { provide: SECRET_RESOLVER, useFactory: () => new DefaultSecretResolver() },
  { provide: LIMITER_BACKEND, useFactory: (c: AppConfig) => (c.redis.url.startsWith('memory:') ? new MemoryLimiterBackend() : new RedisLimiterBackend(c.redis.url)), inject: [APP_CONFIG] },
  { provide: STORAGE, useFactory: (c: AppConfig) => createStorage(c), inject: [APP_CONFIG] },
  { provide: SCANNER, useFactory: (c: AppConfig) => createScanner(c), inject: [APP_CONFIG] },
  { provide: CRM_ADAPTER, useExisting: TwentyAdapter },
  { provide: EXTRACTION_PROVIDER, useExisting: OpenAiProvider },
  { provide: MAILBOX_PROVIDER, useExisting: GraphMailboxProvider },
  {
    provide: CHANNEL_SENDERS,
    useFactory: (c: AppConfig, wa: WhatsAppSender, teams: TeamsSender): ChannelSenders => ({ ...(c.whatsapp ? { whatsapp: wa } : {}), ...(c.teams ? { teams } : {}) }),
    inject: [APP_CONFIG, WhatsAppSender, TeamsSender],
  },
  {
    provide: MEDIA_FETCHERS,
    useFactory: (c: AppConfig, wa: WhatsAppMediaFetcher, teams: TeamsMediaFetcher): MediaFetchers => ({ ...(c.whatsapp ? { whatsapp: wa } : {}), ...(c.teams ? { teams } : {}) }),
    inject: [APP_CONFIG, WhatsAppMediaFetcher, TeamsMediaFetcher],
  },
  { provide: TEAMS_VERIFIER, useFactory: (c: AppConfig) => (c.teams ? new BotFrameworkVerifier(c.teams.appId) : null), inject: [APP_CONFIG] },
];

const domain: Provider[] = [
  WorkspaceLimiter, QueueService, AuditService, TenantService, QuotaService, IdentityService,
  TwentyClient, TwentyAdapter, ActionAuthorizer, StepExecutor, OperationEffects, OperationJournal, ReconciliationService,
  OpenAiProvider, ExtractionService, MediaService, WhatsAppSender, WhatsAppMediaFetcher, TeamsTokenProvider, TeamsSender, TeamsMediaFetcher,
  OutboundService, DraftService, ConfirmationService, DuplicateDetector, MutationBuilder, ReplyService, ConversationService, ReportsService,
  SchedulePlanner, DigestService, SchedulerService, InboundService, IntakeService, AssignmentService, GraphMailboxProvider, MailboxPoller,
  MaintenanceService, TenantProvisioningService, WorkersService,
];

@Global()
@Module({ providers: [...infra, ...domain], exports: [...infra.map((p) => (p as any).provide), ...domain] })
class CoreModule {}

@Module({
  imports: [ConfigModule, DatabaseModule, CoreModule],
  controllers: [WebhooksController, ApiController, AdminController, IntakeWebhookController, HealthController],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ActorGuard },
  ],
})
export class AppModule {}
