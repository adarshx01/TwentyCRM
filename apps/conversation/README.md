# Conversation service

FastAPI service for the conversational CRM. Twenty (`twentycrm/twenty`, pinned in `infra/twenty`) stays the system of record. This process has its own Postgres database and never writes SQL into Twenty.

Architecture: [docs/conversational-crm](../../docs/conversational-crm/README.md). Feasibility gates G1–G5 are open.

## Tests

No phone, Redis, Docker, or live Twenty. The CRM client is faked. Row-level security SQL is checked as text; SQLite does not apply it.

```bash
cd apps/conversation
python3.12 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

## Local API

```bash
cd infra/conversation
docker compose up --build
```

The API container runs `alembic upgrade head` as the Postgres superuser, then serves `uvicorn` on port 3200 as `conversation_app` (the role the policies apply to). The worker container runs `python -m conversation.worker_main` and does not migrate. Copy `.env.example` to `.env` if you run uvicorn on the host instead. Health: http://localhost:3200/health . The WhatsApp and Teams checklist is [docs/conversational-crm/07-operator-whatsapp-teams.md](../../docs/conversational-crm/07-operator-whatsapp-teams.md). Gates G1–G5 are open.
