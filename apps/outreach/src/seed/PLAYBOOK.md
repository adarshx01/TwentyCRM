# CRM field playbook (UI fallback)

Use this when `npm run seed:crm` cannot talk to the Metadata API. Path: Settings → Data Model (enable Advanced / Developers if the menu is hidden).

Work on an empty Recruitment Bricks workspace.

## Opportunity stages

Open **Opportunities → Stage** and make the options:

| Label | Value to aim for |
| --- | --- |
| New | `NEW` |
| Contacted | `CONTACTED` |
| Qualified | `QUALIFIED` |
| Demo scheduled | `DEMO_SCHEDULED` |
| Demo completed | `DEMO_COMPLETED` |
| Proposal | `PROPOSAL` |
| Negotiation | `NEGOTIATION` |
| Closed won | `CLOSED_WON` |
| Closed lost | `CLOSED_LOST` |

If Twenty will not let you change the stored value, keep the labels above; the worker treats any stage matching `/won|lost|closed/i` as closed.

## Company fields

- `employeeRange` — SELECT: RANGE_1_50, RANGE_51_200, RANGE_201_1000, RANGE_1000_PLUS
- `currentAts` — TEXT
- `hiringVolume` — SELECT: LOW, MEDIUM, HIGH
- `researchSummary` — TEXT (long). Worker writes website research here when the field exists.

## Person fields

- `buyerRole` — SELECT: CHRO, TA_HEAD, RECRUITER, HIRING_MANAGER, OTHER

LinkedIn can stay on the native `linkedinLink` field.

## Opportunity fields

- `solutionInterest` — SELECT: AES, VOICEBOT, RESUME_ANALYZER, WHATSAPP, REVERSE_MATCH, CAREER_PAGES, ANALYTICS
- `source` — SELECT: WEBSITE, MANUAL, REFERRAL, LINKEDIN, EVENT, OTHER
- `utmSource`, `utmMedium`, `utmCampaign` — TEXT
- `outreachMode` — SELECT: DRAFT (default), AUTO
- `sequenceStep` — NUMBER (use 1)
- `nextFollowUpAt` — DATE_TIME
- `stopOutreach` — BOOLEAN
- `lastOutreachKey` — TEXT (worker-managed)

## OutreachJob custom object (optional)

Name singular `outreachJob`, plural `outreachJobs`.

Fields: `status` (QUEUED, RESEARCHING, DRAFTED, APPROVED, SENT, SKIPPED, FAILED), `mode` (DRAFT, AUTO), `sequenceStep` (NUMBER), `lastError` (TEXT), `idempotencyKey` (TEXT, unique if offered), relation to Opportunity.

If you skip this object, drafts still land as Notes.

## Note / Task convention (no extra fields)

| Title | Meaning |
| --- | --- |
| `Outreach draft — YYYY-MM-DD` | Generated email, not sent |
| `Outreach sent — YYYY-MM-DD` | Generated email, sent |
| `Review outreach` | Task for a human to approve |

Body footer:

```html
<!-- rb-outreach:opportunity={uuid}:step=1:status=draft -->
```

## Views

1. Opportunities Kanban on Stage → **Sales Pipeline**
2. Filter owner = me → **My Pipeline**
3. Table of `nextFollowUpAt` ≤ today, not closed → **Follow-ups**

## Webhook (optional locally)

Settings → APIs & Webhooks → Webhooks → URL:

`http://host.docker.internal:3100/internal/twenty/webhook`

Copy the signing secret into `TWENTY_WEBHOOK_SECRET`. Manual `POST /outreach/run` does not need this.
