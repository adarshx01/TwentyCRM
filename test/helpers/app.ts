import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, type AppConfig } from '../../src/config/configuration';
import { configureHttp } from '../../src/http-setup';
import { QueueService } from '../../src/queue/queue.service';
import { WorkersService } from '../../src/workers/workers.service';
import { EXTRACTION_PROVIDER } from '../../src/extraction/extraction-provider.interface';
import { CHANNEL_SENDERS, MEDIA_FETCHERS } from '../../src/channels/channel.types';
import { TEAMS_VERIFIER } from '../../src/channels/teams/teams.service';
import { MAILBOX_PROVIDER } from '../../src/intake/mailbox.service';
import { LIMITER_BACKEND, MemoryLimiterBackend } from '../../src/ratelimit/limiter';
import { FakeExtraction, FakeMediaFetcher, RecordingSender } from './fakes';
import { FakeTwenty } from './twenty-fake';
import { createTestDb, type TestDb } from './test-db';
import { metrics } from '../../src/observability/metrics';

export const ADMIN_KEY = 'test-admin-key-test-admin-key-12345';
export const JWT_SECRET = 'test-jwt-secret-test-jwt-secret-12345';
export const WA_SECRET = 'wa-app-secret';
export const WA_VERIFY = 'wa-verify-token';
export const WA_PHONE_ID = '1000000001';

export function testConfig(db: TestDb, twentyUrl: string, storageDir: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    app: { role: 'all', port: 0, nodeEnv: 'test', logLevel: 'error' },
    database: { url: db.appUrl, poolMin: 1, poolMax: 8 },
    redis: { url: process.env.TEST_REDIS_URL! },
    queue: { prefix: `t${Math.random().toString(36).slice(2, 10)}`, outboxPollMs: 100, lockDurationMs: 4000, stalledIntervalMs: 1000 },
    twenty: { apiUrl: twentyUrl, rateLimit: 1_000_000, timeoutMs: 1500, maxConcurrentWrites: 2 },
    workers: { aiConcurrency: 4, crmConcurrency: 4, outboundConcurrency: 4, intakeConcurrency: 2, reminderConcurrency: 2, retryDelayMultiplier: 0.1 },
    whatsapp: { verifyToken: WA_VERIFY, appSecret: WA_SECRET, accessToken: 'wa-token', phoneNumberId: WA_PHONE_ID, graphVersion: 'v21.0', templateName: 'daily_reminder', templateLanguage: 'en' },
    teams: { appId: 'teams-app', appPassword: 'teams-pass', tenantId: 'bot-tenant' },
    openai: { apiKey: 'test', model: 'm', visionModel: 'v', sttModel: 's', baseUrl: 'http://127.0.0.1:1' },
    s3: { endpoint: 'http://127.0.0.1:1', accessKey: 'x', secretKey: 'y', bucket: 'b', region: 'us-east-1' },
    storage: { driver: 'local', localDir: storageDir },
    scanner: { clamavPort: 3310 },
    media: { allowedHosts: ['graph.facebook.com'] },
    email: { webhookSecrets: { testmail: 'email-secret' } },
    observability: { metricsToken: 'metrics-token' },
    agent: {},
    dev: { channel: false },
    security: { jwtSecret: JWT_SECRET, adminApiKey: ADMIN_KEY },
    retention: { draftExpirySeconds: 1800, mediaCleanupHours: 24, mediaRetentionDays: 30, auditRetentionDays: 365, logRetentionDays: 30 },
    ...over,
  };
}

export interface TestEnv {
  app: NestFastifyApplication;
  db: TestDb;
  twenty: FakeTwenty;
  extraction: FakeExtraction;
  whatsapp: RecordingSender;
  teams: RecordingSender;
  media: FakeMediaFetcher;
  mailbox: { list: (...a: any[]) => Promise<any[]> };
  config: AppConfig;
  get<T = any>(token: any): T;
  startWorkers(): Promise<void>;
  close(): Promise<void>;
}

export interface EnvOptions { workers?: boolean; config?: Partial<AppConfig>; twentyRateLimit?: number }

/** Full application against a real Postgres clone and fake external systems. */
export async function createTestEnv(opts: EnvOptions = {}): Promise<TestEnv> {
  const T0 = Date.now(); const tl = (m: string) => process.env.TEST_TIMING && console.log('setup', m, Date.now() - T0);
  metrics.reset();
  const db = await createTestDb(); tl('db');
  const twenty = new FakeTwenty();
  twenty.rateLimitPerMin = opts.twentyRateLimit ?? 1_000_000;
  const twentyUrl = await twenty.start();
  const storageDir = mkdtempSync(join(tmpdir(), 'crmbee-media-'));
  const config = testConfig(db, twentyUrl, storageDir, opts.config);
  const extraction = new FakeExtraction();
  const whatsapp = new RecordingSender('whatsapp');
  const teams = new RecordingSender('teams');
  const media = new FakeMediaFetcher();
  const mailbox: { list: (...a: any[]) => Promise<any[]> } = { list: async () => [] };

  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG).useValue(config)
    .overrideProvider(EXTRACTION_PROVIDER).useValue(extraction)
    .overrideProvider(CHANNEL_SENDERS).useValue({ whatsapp, teams })
    .overrideProvider(MEDIA_FETCHERS).useValue({ whatsapp: media, teams: media })
    .overrideProvider(TEAMS_VERIFIER).useValue({ verify: async (h: string | undefined) => h === 'Bearer valid-teams-token' })
    .overrideProvider(MAILBOX_PROVIDER).useValue({ list: (...a: any[]) => mailbox.list(...a) })
    .overrideProvider(LIMITER_BACKEND).useValue(new MemoryLimiterBackend())
    .compile(); tl('compile');
  const app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ bodyLimit: 24 * 1024 * 1024 }), { rawBody: true });
  await configureHttp(app);
  await app.init(); tl('init');
  await app.getHttpAdapter().getInstance().ready();
  const queue = app.get(QueueService);
  await queue.start({ supervise: false, schedule: false }); tl('queue');
  let workersStarted = false;
  const startWorkers = async () => { if (workersStarted) return; workersStarted = true; await app.get(WorkersService).startWorkers(); };
  if (opts.workers) await startWorkers();

  return {
    app, db, twenty, extraction, whatsapp, teams, media, mailbox, config,
    get: (t) => app.get(t),
    startWorkers,
    async close() {
      const t0 = Date.now(); const lap = (m: string) => process.env.TEST_TIMING && console.log(m, Date.now() - t0);
      await queue.stop(3000).catch(() => undefined); lap('queue.stop');
      await app.close(); lap('app.close');
      await twenty.stop(); lap('twenty.stop');
      rmSync(storageDir, { recursive: true, force: true });
      await db.drop(); lap('drop');
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false | null> | T | undefined | false | null, timeoutMs = 20000, intervalMs = 100, what = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
