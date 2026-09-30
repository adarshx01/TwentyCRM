# Boundaries

## Systems

| System | Owns | Does not own |
| --- | --- | --- |
| **Twenty** (`twentycrm/twenty`, pinned in [`infra/twenty`](../../infra/twenty/docker-compose.yml)) | Contacts, companies, opportunities, notes, tasks, pipeline, UI permissions | Chat drafts, webhook dedupe, channel bindings |
| **App PostgreSQL** | Tenant registry, memberships, channel bindings, drafts, operation journal, outbox, schedules, intake sources, audit | Sales records. No SQL against Twenty’s database |
| **Redis** | Ephemeral queue only | Journals. A Redis flush must not be the only copy of a CRM write (TEN-03, SYNC-01) |
| **Conversation service** | Authorize, confirm, journal, resume | A second CRM UI or a second sales database |

Twenty is the system of record. “Lead” in this product is an Opportunity plus a Person and an optional Company in the client’s Twenty workspace.

## Process boundary

- One deployment of `apps/conversation` serves many clients.
- Each client has one Twenty workspace (`twenty_workspace_id`) on a deployment (`deployment_id`).
- The service calls Twenty’s HTTP API with a key resolved from a **secret reference** stored on the tenant. The key is not a column of plaintext in the app database and is not committed.
- The Recruitment Bricks outreach worker is a different product. Do not route this service’s drafts through `apps/outreach`.

## What the model is allowed to do

LLM or OCR output is a **typed action proposal**. Python validates it against the versioned manifest, checks the actor’s role, and only then runs journal steps. The model does not pick `tenant_id`, does not receive a database session, and does not call Twenty (SEC-02).

## Queue versus journal

Inbound webhooks enqueue a normalized event and return. The worker then resolves membership, writes a draft, and waits for confirmation. CRM side effects are rows in `operations` and `operation_steps`. Those rows live in Postgres. Redis (or the in-process queue used in tests) only holds work to do.
