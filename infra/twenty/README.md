# Twenty CRM (Recruitment Bricks, local)

Official image `twentycrm/twenty`, pinned in `.env` (`TAG=v2.39.5`). This folder is not a fork of Twenty.

```bash
./scripts/up.sh          # generate secrets if needed, compose up, wait for healthz
# CRM: http://localhost:3000   outreach: http://localhost:3100
./scripts/backup.sh      # pg_dump into ./backups/
docker compose down      # stop
```

UI: http://localhost:3000

Railway: `Dockerfile.server` and `Dockerfile.worker` wrap the same image. Add those services in the **same** project as outreach. See [docs/09-hosting.md](../../docs/09-hosting.md).

Postgres is not published. Redis is `127.0.0.1:6379` for the outreach worker.

Full runbook: [docs/05-twenty-ops.md](../../docs/05-twenty-ops.md).
