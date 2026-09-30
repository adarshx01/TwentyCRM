# Hosting and feasibility gates

## Local first

Twenty stays in [`infra/twenty`](../../infra/twenty/docker-compose.yml). Its image is **`twentycrm/twenty`**, default tag `v2.39.5` (`TAG` in that compose file). Do not clone or build `twentyhq/twenty`. This repo does not vendor Twenty source.

The conversation service has its own database:

```bash
cd infra/conversation
docker compose up --build
```

That compose file starts Postgres, Redis, the API, and the worker. It does not attach to Twenty’s `db-data` volume. API: http://localhost:3200/health . Postgres is published on `127.0.0.1:5433` so it does not collide with a local Twenty Postgres. Redis is `127.0.0.1:6380`. The API and worker share `QUEUE_BACKEND=redis`. Twenty being down does not stop the process; `/health` reports `twenty: unreachable` and CRM calls fail closed.

Apply migrations from the API container (`alembic upgrade head` is the container command) or from a venv:

```bash
cd apps/conversation
python3.12 -m venv .venv
.venv/bin/pip install -e '.[dev]'
export DATABASE_URL=postgresql+psycopg://conversation_app:conversation_app@127.0.0.1:5433/conversation
.venv/bin/alembic upgrade head
.venv/bin/uvicorn conversation.main:app --port 3200
```

Tests (no Docker, no Twenty, no phone):

```bash
cd apps/conversation
python3.12 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

SQLite is the test database. RLS statements are PostgreSQL-only; they live in the migration and are asserted as SQL text. See [tenancy](02-tenancy-and-roles.md) for how `conversation_app` and `app.tenant_id` apply on Postgres.

Copy `apps/conversation/.env.example` to `.env` for local runs. `.env` is gitignored. Do not commit API keys.

## Target cloud

Containers are the deployable unit. GCP or OCI is the documented landing zone. **No Terraform is in this pass.** A Railway deploy of this service is optional and must not replace the existing Twenty services. If the Railway CLI is not authenticated, do not invent a deployment; run the compose stack and create one new service from `apps/conversation/Dockerfile` by hand. The WhatsApp and Teams checklist is [07-operator-whatsapp-teams.md](07-operator-whatsapp-teams.md).

Redis is the production queue. The default process uses an in-memory queue so tests and a single-process dev run need no Redis. Set `QUEUE_BACKEND=redis` only when the `redis` package is installed and `REDIS_URL` is set. Journals remain in Postgres either way.

## Out of v1

Customer messaging, campaigns, Slack, Telegram, a custom dashboard, and Outlook sync are out of scope (PDF section 13). Also out of this pass: an approved Meta template in a live business, a packaged Teams zip (the manifest to upload is in the checklist), OCR/STT vendors, and GCP/OCI Terraform.

## Gates (all open)

These gates are **not** done. Code and docs must not claim otherwise.

| Gate | Question still open |
| --- | --- |
| **G1** | Does pinned `twentycrm/twenty` (`v2.39.5` unless `TAG` moves) actually run one workspace per client with `IS_MULTIWORKSPACE_ENABLED`, the way TEN-02 assumes? |
| **G2** | Do Twenty’s own row permissions and the image’s licence match salesperson / manager / CXO / client admin, or is chat-side enforcement the only control? Unproven until that edition is checked. |
| **G3** | Meta business verification, live webhook subscription, approved reminder template, and a real Cloud API send to an allowlisted employee. The adapter is in the service. This gate has not been executed. |
| **G4** | Entra app, Azure Bot, Teams app install, admin consent, and a personal-chat round trip that stores a conversation reference. The adapter is in the service. This gate has not been executed. |
| **G5** | OCR / speech vendor for card and voice capture, plus the GCP or OCI landing zone. Extraction is a fixture provider with no vendor key. |

Next milestone: close G1 and G2 against the pinned image, then walk the operator checklist for one channel. That checklist is not evidence the gate passed.
