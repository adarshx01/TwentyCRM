import { z } from 'zod';

/**
 * Application configuration schema.
 * Validated at startup — the app fails fast on invalid config.
 * Secrets come from environment variables, never hardcoded.
 */
export const AppConfigSchema = z.object({
  app: z.object({
    role: z.enum(['api', 'worker', 'scheduler', 'all']).default('all'),
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
  database: z.object({
    url: z.string().min(1),
    poolMin: z.coerce.number().int().min(1).default(2),
    poolMax: z.coerce.number().int().min(1).default(20),
  }),
  redis: z.object({
    url: z.string().min(1),
  }),
  queue: z.object({
    /** Key prefix in Redis so a shared instance stays tidy */
    prefix: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).default('crmbee'),
    /** How often the outbox relay polls PostgreSQL for unpublished jobs */
    outboxPollMs: z.coerce.number().int().min(50).default(500),
    /** Crash recovery: a worker that stops renewing its lock for this long loses the job to another worker */
    lockDurationMs: z.coerce.number().int().min(1000).default(60_000),
    stalledIntervalMs: z.coerce.number().int().min(500).default(15_000),
  }),
  twenty: z.object({
    apiUrl: z.string().min(1),
    /** Requests per minute per workspace; Twenty documents 100/min, we use 80% (SYNC-04) */
    rateLimit: z.coerce.number().int().min(1).default(80),
    timeoutMs: z.coerce.number().int().min(100).default(15000),
    maxConcurrentWrites: z.coerce.number().int().min(1).default(2),
  }),
  workers: z.object({
    aiConcurrency: z.coerce.number().int().min(1).default(20),
    crmConcurrency: z.coerce.number().int().min(1).default(10),
    outboundConcurrency: z.coerce.number().int().min(1).default(15),
    intakeConcurrency: z.coerce.number().int().min(1).default(5),
    reminderConcurrency: z.coerce.number().int().min(1).default(5),
    /** Scales queue retry delays (tests use a small value) */
    retryDelayMultiplier: z.coerce.number().min(0.01).default(1),
  }),
  whatsapp: z.object({
    verifyToken: z.string().min(1),
    appSecret: z.string().min(1),
    accessToken: z.string().min(1),
    phoneNumberId: z.string().min(1),
    graphVersion: z.string().default('v21.0'),
    templateName: z.string().default('daily_reminder'),
    templateLanguage: z.string().default('en'),
  }).optional(),
  teams: z.object({
    appId: z.string().min(1),
    appPassword: z.string().min(1),
    tenantId: z.string().min(1),
  }).optional(),
  openai: z.object({
    apiKey: z.string().min(1),
    model: z.string().default('gpt-4o-mini'),
    visionModel: z.string().default('gpt-4o'),
    sttModel: z.string().default('whisper-1'),
    baseUrl: z.string().default('https://api.openai.com/v1'),
  }),
  s3: z.object({
    endpoint: z.string().min(1),
    accessKey: z.string().min(1),
    secretKey: z.string().min(1),
    bucket: z.string().min(1),
    region: z.string().default('us-east-1'),
  }),
  storage: z.object({
    driver: z.enum(['s3', 'local']).default('s3'),
    localDir: z.string().default('./.data/media'),
  }),
  scanner: z.object({
    clamavHost: z.string().optional(),
    clamavPort: z.coerce.number().int().default(3310),
  }),
  media: z.object({
    /** Hosts (exact or *.suffix) media may be downloaded from (SEC-01) */
    allowedHosts: z.array(z.string()).default([
      'graph.facebook.com', 'lookaside.fbsbx.com', '*.fbcdn.net', '*.whatsapp.net',
      '*.sharepoint.com', 'smba.trafficmanager.net', '*.teams.microsoft.com', '*.office.net',
    ]),
  }),
  email: z.object({
    /** provider name → HMAC secret for inbound-email webhooks */
    webhookSecrets: z.record(z.string()).default({}),
  }),
  observability: z.object({
    otlpEndpoint: z.string().optional(),
    metricsToken: z.string().optional(),
  }),
  dev: z.object({
    /** Local development chat channel + web UI at /dev/chat. Refused when NODE_ENV=production. */
    channel: z.preprocess((v) => v === '1' || v === 'true' || v === true, z.boolean()).default(false),
  }),
  web: z.object({
    /** Shared secret the Bee app inside Twenty uses to call /v1/crm-chat. Unset = in-CRM chat disabled. */
    token: z.string().min(24).optional(),
  }),
  agent: z.object({
    /** Python LangChain conversation agent; when set it replaces the direct OpenAI provider */
    url: z.string().url().optional(),
    token: z.string().min(16).optional(),
  }),
  security: z.object({
    jwtSecret: z.string().min(32),
    adminApiKey: z.string().min(32),
  }),
  retention: z.object({
    draftExpirySeconds: z.coerce.number().int().default(1800),
    mediaCleanupHours: z.coerce.number().int().default(24),
    mediaRetentionDays: z.coerce.number().int().default(30),
    auditRetentionDays: z.coerce.number().int().default(365),
    logRetentionDays: z.coerce.number().int().default(30),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Load and validate configuration from environment variables.
 * Maps flat env vars to nested config structure.
 */
export function loadConfig(): AppConfig {
  const raw = {
    app: {
      role: process.env.APP_ROLE,
      port: process.env.APP_PORT,
      nodeEnv: process.env.NODE_ENV,
      logLevel: process.env.LOG_LEVEL,
    },
    database: {
      url: process.env.DATABASE_URL,
      poolMin: process.env.DATABASE_POOL_MIN,
      poolMax: process.env.DATABASE_POOL_MAX,
    },
    redis: {
      url: process.env.REDIS_URL,
    },
    queue: {
      prefix: process.env.QUEUE_PREFIX,
      outboxPollMs: process.env.QUEUE_OUTBOX_POLL_MS,
      lockDurationMs: process.env.QUEUE_LOCK_DURATION_MS,
      stalledIntervalMs: process.env.QUEUE_STALLED_INTERVAL_MS,
    },
    twenty: {
      apiUrl: process.env.TWENTY_API_URL,
      rateLimit: process.env.TWENTY_API_RATE_LIMIT,
      timeoutMs: process.env.TWENTY_API_TIMEOUT_MS,
      maxConcurrentWrites: process.env.TWENTY_MAX_CONCURRENT_WRITES,
    },
    workers: {
      aiConcurrency: process.env.WORKER_AI_CONCURRENCY,
      crmConcurrency: process.env.WORKER_CRM_CONCURRENCY,
      outboundConcurrency: process.env.WORKER_OUTBOUND_CONCURRENCY,
      intakeConcurrency: process.env.WORKER_INTAKE_CONCURRENCY,
      reminderConcurrency: process.env.WORKER_REMINDER_CONCURRENCY,
      retryDelayMultiplier: process.env.WORKER_RETRY_DELAY_MULTIPLIER,
    },
    whatsapp: process.env.WHATSAPP_VERIFY_TOKEN ? {
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
      appSecret: process.env.WHATSAPP_APP_SECRET,
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      graphVersion: process.env.WHATSAPP_GRAPH_VERSION,
      templateName: process.env.WHATSAPP_TEMPLATE_NAME,
      templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE,
    } : undefined,
    teams: process.env.TEAMS_APP_ID ? {
      appId: process.env.TEAMS_APP_ID,
      appPassword: process.env.TEAMS_APP_PASSWORD,
      tenantId: process.env.TEAMS_TENANT_ID,
    } : undefined,
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
      visionModel: process.env.OPENAI_VISION_MODEL,
      sttModel: process.env.OPENAI_STT_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL,
    },
    s3: {
      endpoint: process.env.S3_ENDPOINT,
      accessKey: process.env.S3_ACCESS_KEY,
      secretKey: process.env.S3_SECRET_KEY,
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
    },
    storage: { driver: process.env.STORAGE_DRIVER, localDir: process.env.STORAGE_LOCAL_DIR },
    scanner: { clamavHost: process.env.CLAMAV_HOST, clamavPort: process.env.CLAMAV_PORT },
    media: {
      allowedHosts: process.env.MEDIA_ALLOWED_HOSTS ? process.env.MEDIA_ALLOWED_HOSTS.split(',').map((h) => h.trim()) : undefined,
    },
    email: { webhookSecrets: parseJsonEnv(process.env.EMAIL_WEBHOOK_SECRETS) },
    observability: {
      otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
      metricsToken: process.env.METRICS_TOKEN || undefined,
    },
    dev: { channel: process.env.DEV_CHANNEL },
    web: { token: process.env.CRM_CHAT_TOKEN || undefined },
    agent: { url: process.env.AGENT_URL || undefined, token: process.env.AGENT_TOKEN || undefined },
    security: {
      jwtSecret: process.env.JWT_SECRET,
      adminApiKey: process.env.ADMIN_API_KEY,
    },
    retention: {
      draftExpirySeconds: process.env.DRAFT_EXPIRY_SECONDS,
      mediaCleanupHours: process.env.MEDIA_CLEANUP_HOURS,
      mediaRetentionDays: process.env.MEDIA_RETENTION_DAYS,
      auditRetentionDays: process.env.AUDIT_RETENTION_DAYS,
      logRetentionDays: process.env.LOG_RETENTION_DAYS,
    },
  };

  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`
    );
    throw new Error(
      `Configuration validation failed:\n${errors.join('\n')}\n\nCheck your .env file or environment variables.`
    );
  }

  return result.data;
}

function parseJsonEnv(value?: string): Record<string, string> {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('EMAIL_WEBHOOK_SECRETS must be a JSON object of provider → secret');
  }
}

/** NestJS ConfigModule factory */
export const configFactory = () => loadConfig();

/** Injection token for typed config */
export const APP_CONFIG = 'APP_CONFIG';
