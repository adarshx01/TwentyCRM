# Twenty operations (RB)

## Local (this milestone)

From repo root:

```bash
cd infra/twenty
cp .env.example .env   # first time only; up.sh also does this
./scripts/up.sh
```

- UI: [http://localhost:3000](http://localhost:3000)
- Health: `curl -sf http://localhost:3000/healthz`
- Postgres is **not** published. Redis is bound to `127.0.0.1:6379` so the outreach worker on the host can share it (logical DB `1`).
- Image pin: `twentycrm/twenty:v2.39.5` (override `TAG` in `.env` only for a deliberate upgrade).

`./scripts/up.sh` generates `ENCRYPTION_KEY` and `PG_DATABASE_PASSWORD` if they are still placeholders. **Losing `ENCRYPTION_KEY` loses OAuth tokens and other secrets stored in the DB.** Treat `.env` like a password file.

First-run in the UI:

1. Create the workspace (Recruitment Bricks).
2. Settings → enable Advanced / Developers if needed.
3. Settings → APIs & Webhooks → create an API key. Paste into `apps/outreach/.env` as `TWENTY_API_KEY`.
4. Optional: create a webhook to `http://host.docker.internal:3100/internal/twenty/webhook` and put the signing secret in `TWENTY_WEBHOOK_SECRET`.
5. Run `npm run seed:crm` from `apps/outreach` (see playbook if Metadata API rejects a field).

Twenty server compose includes `extra_hosts: host.docker.internal:host-gateway` so webhooks can reach the host.

## Backup

```bash
./scripts/backup.sh
```

Writes `infra/twenty/backups/twenty_YYYYMMDD_HHMMSS.sql`. Off-site copy is your job on a VPS.

Restore (destructive): stop server/worker, `docker exec -i` psql, start again. Practice once before you need it.

## Cloud (near term)

Prefer **Railway**: official Twenty v2 template plus this repo’s outreach Dockerfile. Render can host outreach only. Steps: [09-hosting.md](09-hosting.md).

## Later: VPS

Same compose behind Caddy or Nginx with TLS.

```text
Internet
  → 443 Twenty UI/API
  → 5432 closed
  → Redis closed except the outreach container on the docker network
```

Set `SERVER_URL=https://crm.recruitmentbricks.ai` (or the hostname you actually use). Restart after changing it.

Suggested layout:

- VPS 1: Twenty + Postgres + Redis
- Same VPS or VPS 2: outreach worker
- Daily encrypted `pg_dump` to object storage
- Pin the image tag; read Twenty’s upgrade notes; dump **before** changing `TAG`

RAM: Twenty documents 2 GB minimum; use 4 GB+ if outreach runs on the same box.

## SMTP on Twenty

Leave Twenty `EMAIL_DRIVER` unset locally (logs only). That channel is for invites and in-app mail. Campaigns go through the outreach worker.

When you want Twenty invites: set `EMAIL_DRIVER=smtp` and the `EMAIL_SMTP_*` variables on **both** `server` and `worker`.

## Upgrades

1. `./scripts/backup.sh`
2. Change `TAG` to a full release (e.g. `v2.39.6`), never `latest` in production.
3. `docker compose pull && docker compose up -d`
4. Watch `docker compose logs -f server worker`

## Firewall (VPS)

Allow 80/443 only (plus SSH). Do not publish 5432 or 6379 on `0.0.0.0`.
