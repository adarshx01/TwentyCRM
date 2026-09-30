# Conversation service (local)

Separate Postgres from Twenty. Twenty remains `infra/twenty` using image `twentycrm/twenty`.

```bash
docker compose up --build
# API: http://localhost:3200/health
```

`conversation` (superuser) runs migrations. `conversation_app` serves the API and the worker and is subject to the RLS policies in Alembic revision `0001_initial`.

Services: Postgres `127.0.0.1:5433`, Redis `127.0.0.1:6380`, API `3200`, worker (no host port). The queue is Redis. Journals stay in Postgres.

`/health` reports whether Twenty, Redis, WhatsApp, and Teams are wired. It does not include secrets. An unreachable Twenty does not stop the process.

WhatsApp and Teams credentials are empty until you follow [the operator checklist](../../docs/conversational-crm/07-operator-whatsapp-teams.md). Do not commit `.env`.
