# Deployment

## Topology (MVP: 25 clients / 625 users)

```
Internet ─► HTTPS LB (managed cert, Cloud Armor rate limit) ─► 2 × app node (4 vCPU / 16 GB, two zones)
                                                               ├─ api        (webhooks + APIs)
                                                               ├─ worker ×2  (queue consumers)
                                                               ├─ scheduler  (node 1 only)
                                                               └─ Twenty server + workers (separate compose project)
                                       Cloud SQL PostgreSQL 16 (regional HA, PITR) ── databases: crmbee, twenty (separate roles)
                                       Memorystore Redis (limiter only)   GCS bucket (private media, S3-interop)   Secret Manager
```
Workspaces are a tenant boundary, **not** a compute allocation. API nodes are stateless; scale `api` and `worker`
independently of Twenty. No Kubernetes at this size (see `capacity-and-scaling.md`).

## Prerequisites
GCP project (billing, region), domain + DNS control, Meta Business account (WABA + approved reminder template),
Entra/Azure app registration for the Teams bot, AI provider account with client-approved data terms,
Twenty release pinned and validated (feasibility gates), Twenty commercial/licensing arrangement.

## Steps
1. **Infrastructure**: `cd terraform && terraform init && terraform apply -var project_id=… -var domain=… -var image=… -var alert_email=…`.
   Point DNS at `load_balancer_ip`. Populate the manual secrets listed in the `manual_secrets_to_populate` output.
   (This Terraform is a reviewed reference; apply it first in a scratch project. It has not been applied by the authors.)
2. **Build and push the image** (pin the tag, never `latest`): `docker build -t REGION-docker.pkg.dev/PROJECT/crm-bee/app:1.0.0 . && docker push …`.
3. **Create roles/grants** (if not using Terraform): `crmbee_owner` owns tables and runs migrations; `crmbee_app` is the runtime
   role (**not a superuser, not the owner**, so RLS applies); `GRANT CREATE ON DATABASE crmbee TO crmbee_app` (pg-boss creates its schema).
4. **Migrate (once per release, from the pipeline, with the owner role)**:
   `docker run --rm -e MIGRATION_DATABASE_URL=… $IMAGE node dist/database/migrate.js` — forward-only, advisory-locked, safe to re-run.
5. **Roll out** nodes one at a time. Each process drains on SIGTERM (stops HTTP, finishes in-flight jobs ≤ 25 s). Wait for `/health/ready` before the next node.
6. **Twenty**: deploy separately (pinned release, `IS_MULTIWORKSPACE_ENABLED=true`, wildcard DNS/TLS, S3-compatible storage). **Never auto-upgrade**; promote through staging with the permission and workflow regression suite.
7. **Register webhooks**: Meta → `https://<domain>/webhooks/whatsapp` (verify token = `WHATSAPP_VERIFY_TOKEN`); Azure Bot messaging endpoint → `https://<domain>/webhooks/teams`; email provider → `https://<domain>/intake/email/<provider>`.
8. **Smoke**: `GET /health/ready`, `GET /health/detailed` (admin key), provision a pilot tenant with `--dry-run` first, run the acceptance scenarios on real devices.

## Configuration reference
All configuration is environment variables (`.env.example` documents every key). The process refuses to start on invalid configuration.
Secrets come from Secret Manager; tenants reference secrets by `env:`, `file:` or `gcp-sm:` references — never values.

| Variable | Meaning |
|---|---|
| `APP_ROLE` | `api` \| `worker` \| `scheduler` \| `all` |
| `DATABASE_URL` | Runtime role. May point at PgBouncer (transaction mode) — the app uses unprepared statements and transaction-local settings |
| `QUEUE_DATABASE_URL` | **Direct** Postgres connection for pg-boss (needs session features); defaults to `DATABASE_URL` |
| `REDIS_URL` | `redis://…` / `rediss://…`; `memory://` = in-process limiter (single process only) |
| `TWENTY_API_RATE_LIMIT`, `TWENTY_MAX_CONCURRENT_WRITES`, `TWENTY_API_TIMEOUT_MS` | Protect each workspace (defaults 80/min, 2, 15 s) |
| `WORKER_{AI,CRM,OUTBOUND,INTAKE,REMINDER}_CONCURRENCY`, `WORKER_POLL_INTERVAL_SECONDS` | Pool sizing (see capacity doc) |
| `STORAGE_DRIVER` | `s3` (GCS interop / MinIO) or `local` (dev only) |
| `CLAMAV_HOST` | Enables upload virus scanning (fail-closed) |
| `MEDIA_ALLOWED_HOSTS` | Extra download hosts (default: Meta and Microsoft hosts only) |

## Database connection budget
`pool = DATABASE_POOL_MAX (20) + QUEUE_POOL_MAX (8)` per process. Example MVP: 2 api + 4 worker + 1 scheduler ≈ 7 × 28 ≈ 196 < Cloud SQL `max_connections` 300.
Put PgBouncer (transaction mode) in front of the **API** tier only when connection count approaches the limit; workers and pg-boss keep direct connections.

## Rollback
Application: redeploy the previous image tag (migrations are forward-only and additive; never edit an applied migration — add a new one).
Database: point-in-time recovery to a new instance, then re-point (see `operations.md`).
