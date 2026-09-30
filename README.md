# Recruitment Bricks sales OS

Self-hosted [Twenty CRM](https://github.com/twentyhq/twenty) for **Recruitment Bricks**, plus an outreach worker that researches a prospect’s website and drafts (or optionally sends) a personalized email.

Twenty remains the system of record. The conversational CRM is a separate FastAPI service (`apps/conversation`, see `docs/conversational-crm`). It is not the outreach worker. Feasibility gates G1–G5 are open. WhatsApp and Teams adapters are in the service; the clicks you still have to make in Meta and Azure are in [docs/conversational-crm/07-operator-whatsapp-teams.md](docs/conversational-crm/07-operator-whatsapp-teams.md).

## Quick start

1. **CRM**

   ```bash
   cd infra/twenty
   ./scripts/up.sh
   ```

   Open http://localhost:3000, create the workspace, then create an API key under Settings → APIs & Webhooks.

2. **Outreach**

   ```bash
   cd apps/outreach
   cp .env.example .env   # paste TWENTY_API_KEY
   npm install
   npm run seed:crm       # custom fields; see src/seed/PLAYBOOK.md on failure
   npm run start:dev
   ```

3. **Conversational CRM** (own Postgres, not Twenty’s)

   ```bash
   cd infra/conversation
   docker compose up --build
   ```

   API: http://localhost:3200/health . Worker, Redis, and app Postgres start with it. Twenty does not have to be up. WhatsApp and Teams stay unconfigured until the [operator checklist](docs/conversational-crm/07-operator-whatsapp-teams.md).

4. **Dry-run a deal** — [docs/08-local-e2e.md](docs/08-local-e2e.md)

5. **Host the outreach worker (Railway preferred)** — [docs/09-hosting.md](docs/09-hosting.md). That guide is the Nest outreach worker, not the conversational service.

## Layout

```text
docs/            architecture, data model, lifecycle, hosting, later integrations
infra/twenty/    Docker Compose (local) + Dockerfiles (Railway server/worker)
apps/outreach/   NestJS worker (research, draft, optional send)
apps/conversation/  FastAPI conversational CRM (own database; Twenty stays source of truth)
infra/conversation/ Compose for that service's Postgres and Redis
render.yaml      Render Blueprint for outreach + Redis only
```

## Guide

Start at [docs/README.md](docs/README.md).
