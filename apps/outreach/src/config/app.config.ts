export type AppConfig = {
  port: number;
  twentyBaseUrl: string;
  twentyApiKey: string;
  twentyWebhookSecret: string;
  redisUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiBaseUrl: string;
  sendEnabled: boolean;
  resendApiKey: string;
  fromEmail: string;
  fromName: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
};

export function redisLooksLocal(url: string): boolean {
  return /127\.0\.0\.1|localhost/i.test(url);
}

export function loadConfig(): AppConfig {
  const sendRaw = (process.env.OUTREACH_SEND_ENABLED ?? 'false').toLowerCase();
  return {
    port: Number(process.env.PORT ?? 3100),
    twentyBaseUrl: (process.env.TWENTY_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    twentyApiKey: process.env.TWENTY_API_KEY ?? '',
    twentyWebhookSecret: process.env.TWENTY_WEBHOOK_SECRET ?? '',
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    openaiBaseUrl: (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    sendEnabled: sendRaw === 'true' || sendRaw === '1',
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    fromEmail: process.env.FROM_EMAIL ?? 'sales@recruitmentbricks.ai',
    fromName: process.env.FROM_NAME ?? 'Recruitment Bricks',
    smtpHost: process.env.SMTP_HOST ?? '',
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpUser: process.env.SMTP_USER ?? '',
    smtpPassword: process.env.SMTP_PASSWORD ?? '',
  };
}
