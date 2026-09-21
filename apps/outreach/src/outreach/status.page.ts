import { loadConfig, redisLooksLocal } from '../config/app.config';

export type WiringStatus = {
  ok: true;
  service: 'rb-outreach';
  twentyBaseUrl: string;
  twentyApiKeyConfigured: boolean;
  redisLooksLocal: boolean;
  sendEnabled: boolean;
};

export function wiringStatus(): WiringStatus {
  const cfg = loadConfig();
  return {
    ok: true,
    service: 'rb-outreach',
    twentyBaseUrl: cfg.twentyBaseUrl,
    twentyApiKeyConfigured: Boolean(cfg.twentyApiKey),
    redisLooksLocal: redisLooksLocal(cfg.redisUrl),
    sendEnabled: cfg.sendEnabled,
  };
}

export function statusHtml(): string {
  const s = wiringStatus();
  const redisRow = s.redisLooksLocal
    ? 'Redis is still 127.0.0.1. In Railway → this service → Variables set REDIS_URL=${{Redis.REDIS_URL}}/1?family=0 (Redis plugin must exist in this same project).'
    : 'Redis URL is not localhost — queue wiring looks set.';
  const twentyRow = s.twentyApiKeyConfigured
    ? `API key is set. Base URL: ${escapeHtml(s.twentyBaseUrl)}`
    : `No TWENTY_API_KEY. Set TWENTY_BASE_URL to the Twenty server public URL (not this outreach URL) and paste TWENTY_API_KEY from Twenty → Settings → APIs. Current base: ${escapeHtml(s.twentyBaseUrl)}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Recruitment Bricks outreach</title>
  <style>
    body { font: 16px/1.45 system-ui, sans-serif; max-width: 42rem; margin: 2.5rem auto; padding: 0 1.25rem; color: #111; }
    code { font-size: 0.92em; }
    .warn { background: #fff4e5; border: 1px solid #e6c07b; padding: 0.75rem 1rem; }
    .ok { background: #eef8ee; border: 1px solid #8fbf8f; padding: 0.75rem 1rem; }
  </style>
</head>
<body>
  <h1>Outreach worker</h1>
  <p>This URL is the Recruitment Bricks <strong>email outreach API</strong>. It is not Twenty CRM. There is no login screen here on purpose.</p>
  <p>JSON health: <a href="/health"><code>/health</code></a>. Run a deal: <code>POST /outreach/run</code>.</p>
  <h2>Wiring</h2>
  <p class="${s.redisLooksLocal ? 'warn' : 'ok'}">${escapeHtml(redisRow)}</p>
  <p class="${s.twentyApiKeyConfigured ? 'ok' : 'warn'}">${escapeHtml(twentyRow)}</p>
  <p>The CRM UI is a separate Railway service that uses the <code>twentycrm/twenty</code> image (Postgres + Redis + server + worker). Put that in the <strong>same</strong> Railway project as this service, then set <code>REDIS_URL</code>, <code>TWENTY_BASE_URL</code>, and <code>TWENTY_API_KEY</code>.</p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
