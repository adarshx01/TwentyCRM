# Conversational CRM

This is the PDF v1.1 product: a **multi-client internal sales service**. It is not the Recruitment Bricks outbound-email worker in [`apps/outreach`](../../apps/outreach). Version 1 does not send customer outreach or campaigns. The Nest worker stays as-is.

Twenty stays the only sales database and the only web UI. The new service is [`apps/conversation`](../../apps/conversation). It never writes SQL into Twenty’s database.

```text
WhatsApp adapter ─┐
Teams adapter    ─┼─► Identity and tenancy ─► Drafts and confirmation ─► CRM adapter ─► Twenty workspace
Email intake     ─┘            │                        │
                               ▼                        ▼
                        App PostgreSQL            Operation journal
                        (separate database)       Reminders (channel port)
```

## Reading order

1. [Boundaries](01-boundaries.md)
2. [Tenancy and roles](02-tenancy-and-roles.md)
3. [Request path](03-request-path.md)
4. [Data model](04-data-model.md)
5. [Channels and intake](05-channels-and-intake.md)
6. [Hosting and feasibility gates](06-hosting-and-gates.md)
7. [WhatsApp and Teams operator checklist](07-operator-whatsapp-teams.md)

## What this pass builds

A FastAPI service with tenant-scoped drafts, an operation journal, a Twenty REST client behind an interface, webhook signature checks, and an email-intake parser. Tests run on SQLite with a fake CRM client. They do not need a phone, a Teams tenant, or a live Twenty.

Postgres row-level security SQL ships in the Alembic migration. SQLite unit tests do not execute that SQL. See [hosting](06-hosting-and-gates.md).

## Feasibility gates

**G1–G5 are open.** Nothing in this tree should be read as proof that they passed. The list is in [hosting and gates](06-hosting-and-gates.md).
