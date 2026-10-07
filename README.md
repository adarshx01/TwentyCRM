# CRM Bee — Conversational CRM for Twenty (WhatsApp + Microsoft Teams)

A multi-tenant service that lets salespeople capture leads (business cards, voice notes, text), maintain opportunities,
receive a morning task digest and ask for summaries **from chat**, while **Twenty CRM stays the system of record**.
It also ingests website contact-form emails into the same CRM with an internal review queue.

Specification: [`ApplicationBRD/Conversational_CRM_Requirements.md`](ApplicationBRD/Conversational_CRM_Requirements.md) (YlogX v1.1).
Requirement-by-requirement status: [`docs/requirements-audit.md`](docs/requirements-audit.md).

| | |
|---|---|
| Language / runtime | TypeScript 5 on Node 22 (strict) |
| Framework | NestJS 11 on Fastify |
| Data | PostgreSQL 16 (Drizzle ORM, row-level security), pg-boss queue in the same database, Redis only for rate-limit counters/leases |
| Contracts | Zod (strict, discriminated unions) |
| Channels | WhatsApp Cloud API (direct), Microsoft Teams (Bot Framework REST + Adaptive Cards), inbound email webhook / Graph mailbox / signed form events |
| AI | Provider interface (OpenAI-compatible HTTP implementation). The model only *proposes*; code authorizes and executes |
| Storage | S3-compatible private bucket (or local disk for development) |

## Quick start (development)

```bash
pnpm install
cp .env.example .env            # fill secrets; REDIS_URL=memory:// works for a single process
docker compose up -d postgres redis minio minio-init
pnpm build
MIGRATION_DATABASE_URL=postgresql://crmbee_owner:crmbee_owner@localhost:5432/crmbee pnpm migrate
APP_ROLE=all pnpm start:prod    # api + worker + scheduler in one process
curl localhost:3000/health/ready
```

Provision a tenant (idempotent; see `examples/tenant-manifest.example.json`):

```bash
ADMIN_API_URL=http://localhost:3000 ADMIN_API_KEY=… node scripts/provision.mjs examples/tenant-manifest.example.json --dry-run
```

## Tests

```bash
pnpm test               # unit (no database)
pnpm test:integration   # real PostgreSQL (an ephemeral cluster is started automatically; no Docker needed)
pnpm test:e2e           # full app: HTTP + real queue/workers + real PostgreSQL + fake Twenty/providers
pnpm test:all           # everything
pnpm typecheck && pnpm lint
```

Integration/e2e tests need PostgreSQL server binaries on the machine (`/usr/lib/postgresql/*/bin`, or set `PG_BIN`).
They run as a **non-superuser** role so RLS is genuinely enforced. `redis-memory-server` builds a real Redis for the
limiter tests. Set `TEST_PG_ADMIN_URL` to reuse an existing server (CI service container).

## Process roles (one image)

| `APP_ROLE` | Does | Scale by |
|---|---|---|
| `api` | webhooks, employee API, admin API, health/metrics. Verifies → persists → enqueues → acknowledges | replicas behind the LB |
| `worker` | queue consumers: inbound events, AI extraction, CRM writes, outbound sends, reminders, intake, reconciliation | replicas + `WORKER_*_CONCURRENCY` |
| `scheduler` | cron producers (digest tick, planner, retention, fan-out). Exactly one needed; duplicates are safe | 1 (HA via restart) |
| `all` | everything (development / tiny installs) | — |

## Documentation

- [Architecture & decisions](docs/architecture.md) · [Capacity & scaling](docs/capacity-and-scaling.md) · [Security](docs/security.md)
- [API](docs/api.md) · [`openapi.yaml`](docs/openapi.yaml)
- [Deployment](docs/deployment.md) · [Operations & runbooks](docs/operations.md) · [Troubleshooting](docs/troubleshooting.md)
- [Client onboarding checklist](docs/onboarding-checklist.md) · [Twenty field mapping](docs/twenty-mapping.md) · [Feasibility gates G1–G5](docs/feasibility-gates.md)
- [Load report](docs/load-report.md) · [Requirements audit](docs/requirements-audit.md)

## Hard limits you should know before relying on it

This repository is verified by automated tests against **fakes of the external systems** (a protocol-level fake Twenty,
recording WhatsApp/Teams senders, a scripted AI provider). Nothing here has been run against a live Twenty, WhatsApp
number, Teams tenant, OpenAI account or GCP project. [`docs/feasibility-gates.md`](docs/feasibility-gates.md) lists exactly
what must be proven live before production, and [`docs/requirements-audit.md`](docs/requirements-audit.md) marks every
requirement as *verified by automated test*, *implemented, needs live verification*, or *not implemented*.
