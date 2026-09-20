# Hosting (Railway first, Render fallback)

This repo is two runtimes: **Twenty CRM** (official Docker image) and the **outreach worker** (this repo’s NestJS app). Do not build Twenty from this git tree.

Railway is the path that actually matches Twenty’s production shape (Postgres, Redis, a separate worker process, and object storage). Render can run outreach; its older Twenty blueprints are stale and disks cannot be shared between a server and a worker.

You still need a Railway or Render account in the browser. There is no CLI login in this workspace, so nothing is live in the cloud until you click deploy.

## Railway (recommended)

### 1. Twenty CRM

Deploy the v2 template (server, worker, PostgreSQL 16, Redis with `noeviction`, object storage):

[https://railway.com/deploy/twenty-crm-v2-railway](https://railway.com/deploy/twenty-crm-v2-railway)

After it is healthy:

1. Open the **server** public URL and create the Recruitment Bricks workspace.
2. Settings → APIs & Webhooks → create an API key (and optionally a webhook).
3. Pin **server** and **worker** to the same image tag you use locally (`twentycrm/twenty:v2.39.5`) if the template shipped a different version. Change both together; never leave them split.
4. Copy `ENCRYPTION_KEY` somewhere durable. Rotating it without Twenty’s procedure locks you out of encrypted fields.

Template details that matter:

| Variable | Why |
| --- | --- |
| `NODE_PORT` / `PORT` | Both `3000`. Twenty listens on `NODE_PORT`, not Railway’s default `PORT`. |
| `SERVER_URL` | `https://${{server.RAILWAY_PUBLIC_DOMAIN}}` |
| `REDIS_URL` | Must include `?family=0` for Railway private DNS. |
| `STORAGE_TYPE` | `S_3` (Railway services cannot share a volume). |

### 2. Outreach worker

In the **same Railway project** (so it can reach Redis privately):

1. New service → GitHub (push this repo) **or** empty service → Dockerfile.
2. **Root directory:** `apps/outreach` (uses `Dockerfile` + `railway.toml`).
3. Generate a public domain for outreach.

Variables:

```text
NODE_ENV=production
TWENTY_BASE_URL=https://<twenty-server-public-domain>
TWENTY_API_KEY=<from Twenty>
TWENTY_WEBHOOK_SECRET=<optional, webhook HMAC>
OUTREACH_API_TOKEN=<long random; required so /outreach/run is not public>
REDIS_URL=redis://:${{redis.REDIS_PASSWORD}}@${{redis.RAILWAY_PRIVATE_DOMAIN}}:6379/1?family=0
OUTREACH_SEND_ENABLED=false
OPENAI_API_KEY=
FROM_EMAIL=sales@recruitmentbricks.ai
FROM_NAME=Recruitment Bricks
```

Logical Redis DB **1** keeps BullMQ off Twenty’s default DB 0.

Health: `GET https://<outreach-domain>/health`

In Twenty, point the webhook at `https://<outreach-domain>/internal/twenty/webhook`.

Trigger a deal (replace token and id):

```bash
curl -sS -X POST "https://<outreach-domain>/outreach/run" \
  -H "Authorization: Bearer $OUTREACH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"opportunityId":"<uuid>"}'
```

Leave `OUTREACH_SEND_ENABLED=false` until SMTP/Resend is configured.

### 3. Seed CRM fields

From a laptop that can reach the public Twenty URL, with `TWENTY_BASE_URL` and `TWENTY_API_KEY` in `apps/outreach/.env`:

```bash
cd apps/outreach
npm run seed:crm
```

Or finish [apps/outreach/src/seed/PLAYBOOK.md](../apps/outreach/src/seed/PLAYBOOK.md) in the UI.

## Render (outreach only)

[`render.yaml`](../render.yaml) at the repo root creates **rb-outreach** (Docker) and a private Redis (`noeviction`). Connect the GitHub repo in the Render dashboard and apply the Blueprint.

Then set in the dashboard (Blueprint leaves them for you):

- `TWENTY_BASE_URL` — public Twenty URL (Railway or elsewhere)
- `TWENTY_API_KEY`
- `TWENTY_WEBHOOK_SECRET` if you use webhooks
- `OPENAI_API_KEY` if you want LLM drafts

`OUTREACH_API_TOKEN` is generated. Copy it from the Render env UI.

Do **not** run Twenty from this Blueprint. Attachments need object storage that both the Twenty server and worker can see; Render disks are per-service. If you later insist on Twenty on Render, use Cloudflare R2 (or S3) with `STORAGE_TYPE=S_3` and the same `STORAGE_S3_*` on server and worker, and set `NODE_PORT` to Render’s `PORT`.

## What this environment cannot do

Railway CLI is not installed here and there is no authenticated Render/Railway session. Hosting is configured and documented; the first production deploy is a dashboard click after this repo is on GitHub (or after you `railway link` locally).
