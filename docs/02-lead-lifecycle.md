# Lead lifecycle

An inbound or manually entered prospect becomes an **Opportunity**. Stage changes are the only lifecycle. Email automation reads those stages; it does not invent a parallel status field.

## Happy path

```text
NEW
  → CONTACTED          (first outreach drafted/sent, or first human touch logged)
  → QUALIFIED          (budget / authority / need confirmed)
  → DEMO_SCHEDULED
  → DEMO_COMPLETED
  → PROPOSAL
  → NEGOTIATION
  → CLOSED_WON | CLOSED_LOST
```

## Stage entry rules

| Stage | Enter when |
| --- | --- |
| `NEW` | Company + Person exist; Opportunity created. No meaningful conversation yet. |
| `CONTACTED` | Outreach email sent, or salesperson logged a real touch. Draft-only does **not** move the stage. |
| `QUALIFIED` | Fit for RB (hiring volume, ATS pain, stakeholder identified). |
| `DEMO_SCHEDULED` | Calendar hold exists. |
| `DEMO_COMPLETED` | Demo happened; notes on the Opportunity. |
| `PROPOSAL` | Commercial proposal sent. |
| `NEGOTIATION` | Terms in play. |
| `CLOSED_WON` | Signed / PO. Set `stopOutreach = true`. |
| `CLOSED_LOST` | Lost or disqualified. Set `stopOutreach = true`. Reason in a Note. |

## Assignment

RB-first: one workspace, assign `accountOwnerId` on Company and keep Opportunity owner consistent.

When website capture exists later, route by `solutionInterest` if you split owners; until then, assign manually.

## Outreach stop conditions

The worker **must not send** (and should skip auto-draft spam) when any of:

- `stopOutreach` is true
- stage is `CLOSED_WON` or `CLOSED_LOST`
- a Note on the Opportunity contains `rb-outreach` footer `status=reply-received`
- an OutreachJob for `{opportunityId}:{sequenceStep}` is already `DRAFTED` or `SENT`

Draft mode on a brand-new `NEW` deal is always allowed once per `sequenceStep`.

## Duplicate detection (when website/API ingest exists)

```text
email exact match?  → attach existing Person
        ↓ no
email domain is a company domain?
        ↓ yes
Company.domain match? → attach / create Person on that Company
        ↓ no
create Company from domain, then Person, then Opportunity NEW
```

Public email domains never create a Company from the domain alone; require an explicit company name.

## Activity expectations

Every meaningful event leaves a Note or Task on the Opportunity:

- research summary (Company `researchSummary` + optional Note)
- outreach draft / sent
- demo notes
- closed-lost reason
