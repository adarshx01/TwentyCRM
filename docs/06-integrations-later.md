# Integrations later (WhatsApp + Teams)

Not built in this milestone. The outreach NestJS app is the future integration layer so we do not grow a second brain.

## Rule

Website, WhatsApp, and Teams **feed Twenty** and **read Twenty**. They do not store companies, people, or deal stages.

## Integration database (mapping only)

When you add channels, keep a small store (Postgres next to the worker):

- `integration_users` — Teams AAD id ↔ Twenty workspace member ↔ role
- `external_contacts` — WhatsApp phone ↔ Person id
- `message_mappings` — WhatsApp/Teams message id ↔ Note/activity id
- `automation_jobs` — already started as OutreachJob

This is not a CRM.

## WhatsApp (Business Platform)

```text
Customer ↔ Cloud API ↔ worker webhook ↔ Twenty Note + Person match on phone
Sales (later via Teams) → worker → Cloud API → customer, then Note outbound
```

- Verify Meta signatures; idempotent on `wamid`.
- Conversation record (open/assigned/last_message_at) can live in the integration DB; the **content** is a Note on the Person/Opportunity.
- Template messages vs session messages follow Meta policy; do not invent a parallel lead object.

## Teams (bot, not incoming webhook only)

Incoming webhooks are fine for “new lead” pings. Interactive CRM needs a **bot/app**:

| Command | Worker | Twenty |
| --- | --- | --- |
| Find Acme | search companies | return owner, open opps, last activity |
| Create lead for Rahul at Acme, VoiceBot | match/create Company+Person+Opportunity | confirm |
| Move Acme to Proposal | permission check, patch stage | confirm |
| What do I follow up today? | query owner + `nextFollowUpAt` | list |

Auth:

```text
Teams (Entra ID) → worker → Twenty API key or user OAuth
```

Never put the Twenty key in the Teams client. Map salesperson → Twenty member → role (own records vs team vs admin).

## Queueing

Do not do Twenty + WhatsApp + Teams + email inside one HTTP request. BullMQ already backs outreach; reuse it for channel jobs, retries, and a dead-letter queue.

## Website ingest

`POST /api/leads` (see [04](04-website-solutions.md)) should 202 after validation, then the same match/create path as manual CRM entry, then optional outreach enqueue.

## Event envelope (internal)

```json
{
  "event": "lead.created",
  "source": "website",
  "opportunityId": "…",
  "solution": "VOICEBOT",
  "timestamp": "…"
}
```

The worker fans out to Twenty (already written), email, Teams notify — not the website calling each system.

## Security checklist when you build this

- Webhook signature verification (Twenty, Meta, Teams)
- Rate limits on public lead POST
- Audit log: actor, action, resource, id
- Secrets only in the worker environment
