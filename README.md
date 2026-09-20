# Recruitment Bricks sales OS

Self-hosted [Twenty CRM](https://github.com/twentyhq/twenty) for **Recruitment Bricks**, plus an outreach worker that researches a prospect’s website and drafts (or optionally sends) a personalized email.

Twenty remains the system of record. WhatsApp, Teams, and the marketing Solutions pages are specified in `docs/` and not built yet.

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

3. **Dry-run a deal** — [docs/08-local-e2e.md](docs/08-local-e2e.md)

4. **Host (Railway preferred)** — [docs/09-hosting.md](docs/09-hosting.md)

## Layout

```text
docs/            architecture, data model, lifecycle, hosting, later integrations
infra/twenty/    Docker Compose for Twenty + Postgres + Redis
apps/outreach/   NestJS worker (research, draft, optional send)
render.yaml      Render Blueprint for outreach + Redis only
```

## Guide

Start at [docs/README.md](docs/README.md).
