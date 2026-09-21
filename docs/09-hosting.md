# Hosting on Railway

You currently have **two disconnected Railway projects**. That is why the browser looks empty and the template “does nothing” for outreach.

| Project | What it is | Status from your screenshots |
| --- | --- | --- |
| **clever-compassion** → service `TwentyCRM` | This GitHub repo = **outreach API only** | Running. `GET /` used to 404. `/health` was 200. Redis = `127.0.0.1` (useless). **0 Variables**. |
| **strong-art** → Twenty template | Official CRM: redis, postgres, worker, server, storage | Redis/Postgres up. **Server build failed**, so **worker crashed** (it waits for `SERVER_URL/healthz`). Storage bucket empty. |

Railway does not merge projects. `${{Redis.REDIS_URL}}` only works **inside the same project**. Outreach in clever-compassion cannot see redis in strong-art.

## Why `twentycrm-production-7493.up.railway.app` is not a CRM

That hostname is the Nest app from **this repo**. It has no Twenty React UI. Until the homepage change is deployed, `GET /` is `Cannot GET /` — that JSON **is** our app answering. Open `/health` if the homepage is not on Railway yet.

Twenty’s UI is whatever domain is on the **server** service (`server-production-….up.railway.app` in the template). That service never came up in strong-art.

## Why Twenty is not “inside” this git repo as source

[twentyhq/twenty](https://github.com/twentyhq/twenty) is a huge Nx monorepo. We **consume** the published image `twentycrm/twenty` (same as [self-host Docker Compose](https://docs.twenty.com/developers/self-host/capabilities/docker-compose)). Forking it would mean you maintain CRM upgrades. Outreach (research + draft email) stays our Nest service.

This repo now wraps that image:

- `infra/twenty/Dockerfile.server`
- `infra/twenty/Dockerfile.worker`
- Local Compose remains `infra/twenty/docker-compose.yml`

Exact paste-ready variables: [infra/railway/variables.env.example](../infra/railway/variables.env.example).

## Make one working Railway project

Use **clever-compassion** (outreach already builds). Pause or delete **strong-art** so the $5 trial is not spent on a dead template.

In **clever-compassion**, **+ New**:

### 1. Databases (plugins, not this GitHub repo)

- **Redis**
- **PostgreSQL**

### 2. Twenty server (same GitHub repo as outreach)

- New service → GitHub → `adarshx01/TwentyCRM`
- Builder: **Dockerfile**
- Dockerfile path: `infra/twenty/Dockerfile.server`
- Generate a **public domain** (this is the CRM you open in the browser)
- Health path: `/healthz`

Variables (names must match your plugin names; click Variable → Add variable reference):

```text
PORT=8080
NODE_PORT=8080
PG_DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}?family=0
SERVER_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
ENCRYPTION_KEY=<openssl rand -base64 32, then copy to worker>
APP_SECRET=<random, then copy to worker>
STORAGE_TYPE=S_3
STORAGE_S3_REGION=auto
STORAGE_S3_NAME=${{twenty-storage.BUCKET}}
STORAGE_S3_ENDPOINT=${{twenty-storage.ENDPOINT}}
STORAGE_S3_ACCESS_KEY_ID=${{twenty-storage.ACCESS_KEY_ID}}
STORAGE_S3_SECRET_ACCESS_KEY=${{twenty-storage.SECRET_ACCESS_KEY}}
```

If you have no bucket yet: **+ New** → storage/bucket named `twenty-storage`. Without it, skip `STORAGE_*` and set `STORAGE_TYPE=local` **only to get a first login**; attachments and the worker will be wrong.

### 3. Twenty worker (same repo)

- Dockerfile path: `infra/twenty/Dockerfile.worker`
- **No** public domain
- Copy the same `PG_DATABASE_URL`, `REDIS_URL`, `SERVER_URL`, `ENCRYPTION_KEY`, `APP_SECRET`, `STORAGE_*`
- Extra:

```text
DISABLE_DB_MIGRATIONS=true
DISABLE_CRON_JOBS_REGISTRATION=true
```

Worker starts only after server `/healthz` is up.

### 4. Wire outreach (existing `TwentyCRM` service)

Rename it to `outreach` in the UI. **Variables** (you currently have none):

```text
REDIS_URL=${{Redis.REDIS_URL}}/1?family=0
TWENTY_BASE_URL=https://${{twenty-server.RAILWAY_PUBLIC_DOMAIN}}
TWENTY_API_KEY=<from Twenty Settings → APIs after first login>
OUTREACH_API_TOKEN=<long random>
OUTREACH_SEND_ENABLED=false
```

Redeploy outreach. Deploy logs must **not** say `redis://127.0.0.1:6379/1`.

### 5. First login

Open the **server** public URL (not `…-7493…`). Create the Recruitment Bricks workspace. Then seed from your laptop:

```bash
cd apps/outreach
# TWENTY_BASE_URL=https://<server-domain>
# TWENTY_API_KEY=...
npm run seed:crm
```

## Why the official template failed

The [Railway Twenty v2 template](https://railway.com/deploy/twenty-crm-v2-railway) is the right *shape*, but in **strong-art** the **server image never built**. The worker script waits for `SERVER_URL/healthz` and then exits. Empty `twenty-storage` also means S3 vars are missing. Fixing it in a second project does not help outreach until both live together.

Trial credit (**30 days or $5**) will not hold a full Twenty stack for long. If server build fails again, use local `infra/twenty` until you pay or move to a VPS.

## Render

[`render.yaml`](../render.yaml) is still outreach + Redis only.
