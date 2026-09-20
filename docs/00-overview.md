# Recruitment Bricks sales OS

This is the operating model for selling **Recruitment Bricks** (YlogX Private Limited). Twenty CRM is the system of record. Everything else reads from or writes into Twenty.

## What we are building

A small sales operating system:

| Layer | Role | Status |
| --- | --- | --- |
| Website (`recruitmentbricks.ai`) | Acquisition: Solutions pages, demo forms, UTM | Spec only (`04-website-solutions.md`) |
| **Twenty CRM** | Source of truth for companies, people, deals, activity | **Build now** (local Docker; Railway for hosted) |
| **Outreach worker** | Research a lead’s website, draft or send a personalized email | **Build now** |
| Email provider | Delivery (Resend/SMTP). Does not own customer state | Dry-run now, send later |
| WhatsApp Business API | Customer conversation transport | Later (`06-integrations-later.md`) |
| Microsoft Teams | Salesperson interface that never holds a second CRM | Later (`06-integrations-later.md`) |

## Design principle

```text
Website  →  lead generation
Twenty   →  data / system of record
Outreach →  brain / router
Email    →  automated communication
WhatsApp →  customer conversation        (later)
Teams    →  salesperson interface        (later)
```

Do not let the website, Teams, WhatsApp, or the outreach database become independent customer databases. Mappings and job state may live next to Twenty; names, stages, owners, and history live **in** Twenty.

## Mental model

```text
                    ┌─────────────┐
                    │   WEBSITE   │
                    └──────┬──────┘
                           │ lead generation
                           ▼
                 ┌──────────────────┐
                 │      TWENTY      │
                 │  SOURCE OF TRUTH │
                 └────────┬─────────┘
                          │
             ┌────────────┼─────────────┐
             │            │             │
             ▼            ▼             ▼
          Email        WhatsApp       Teams
             │            │             │
             └────────────┼─────────────┘
                          │
                     sales activity
```

## Native Twenty mapping

Sales language maps onto Twenty objects. There is no separate “Lead” database.

| Sales language | Twenty object |
| --- | --- |
| Prospect account | **Company** (match on domain) |
| Buyer contact | **Person** (match on email) |
| Lead / deal | **Opportunity** (stage is the lifecycle; a new inbound lead is stage `NEW`) |
| Follow-up | **Task** |
| Research, drafts, sent mail | **Note** (linked via noteTargets) |
| Outreach run | **OutreachJob** custom object when seed succeeds; otherwise the same facts are stored on Notes + Opportunity fields |

## Current milestone

Local Docker Twenty for RB + AI outreach in **draft** mode:

1. Sales creates or imports a Company, Person, and Opportunity in Twenty.
2. Outreach is triggered (manual `POST /outreach/run` or Twenty webhook).
3. Worker fetches the company website (bounded), summarizes it, writes a personalized email.
4. Default: attach an **Outreach draft** Note and a **Review outreach** Task. Do not send mail.
5. Auto-send is opt-in (`OUTREACH_SEND_ENABLED=true` and Opportunity `outreachMode = AUTO`).

## Repositories and licenses

This repo does **not** vendor Twenty source (AGPL-3.0). It consumes the official image `twentycrm/twenty` and our own NestJS worker.

- CRM UI: `http://localhost:3000` after `infra/twenty` is up.
- Outreach API: `http://localhost:3100`.

## Reading order

1. [01 — CRM data model](01-crm-data-model.md)
2. [02 — Lead lifecycle](02-lead-lifecycle.md)
3. [03 — Email outreach](03-email-outreach.md)
4. [05 — Twenty ops](05-twenty-ops.md)
5. [08 — Local dry run](08-local-e2e.md)
6. Later: [04 Solutions](04-website-solutions.md), [06 Integrations](06-integrations-later.md), [07 Source of truth](07-source-of-truth.md)
