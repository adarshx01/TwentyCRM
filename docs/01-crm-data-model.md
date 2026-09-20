# CRM data model (Recruitment Bricks)

Configure Twenty around **selling** Recruitment Bricks to TA/HR teams. This is not the ATS candidate database.

Seed with `npm run seed:crm` in `apps/outreach` after you have an API key, or follow the UI playbook in the same file as the seed script (`apps/outreach/src/seed/PLAYBOOK.md`).

## Objects

### Company

Prospect employer (the account).

| Field | Type | Notes |
| --- | --- | --- |
| `name` | text | Account name |
| `domainName` | links | **Unique in Twenty.** Primary matching key (`acme.com`) |
| `website` | links (custom, if you want a separate careers URL) | Optional; outreach falls back to `domainName` |
| `employees` | number | Native |
| `employeeRange` | SELECT | `RANGE_1_50`, `RANGE_51_200`, `RANGE_201_1000`, `RANGE_1000_PLUS` |
| `currentAts` | text | What they use today |
| `hiringVolume` | SELECT | `LOW`, `MEDIUM`, `HIGH` |
| `researchSummary` | textarea/text | Written by the outreach worker; facts only |
| `accountOwnerId` | relation | Workspace member |

Matching: normalize host from email domain or URL. Skip public inboxes (`gmail.com`, `outlook.com`, `hotmail.com`, `yahoo.com`, `icloud.com`, `proton.me`).

### Person

Buyer-side contact.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | full name | |
| `emails.primaryEmail` | email | **Unique in Twenty.** Primary matching key |
| `phones` | phones | E.164 when possible |
| `jobTitle` | text | Native |
| `companyId` | relation → Company | |
| `linkedinLink` | links | Native; custom `linkedinUrl` only if you prefer a simple text field |
| `buyerRole` | SELECT | `CHRO`, `TA_HEAD`, `RECRUITER`, `HIRING_MANAGER`, `OTHER` |

Duplicate rule: exact email → same Person. Never create four copies of the same human.

### Opportunity

The deal. In this OS, “lead” means an Opportunity in `NEW`.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | text | `{Company} — {solution}` |
| `stage` | SELECT | See [lifecycle](02-lead-lifecycle.md) |
| `amount` | currency | Optional until proposal |
| `closeDate` | date | |
| `companyId` | relation → Company | |
| `pointOfContactId` | relation → Person | |
| `solutionInterest` | SELECT | `AES`, `VOICEBOT`, `RESUME_ANALYZER`, `WHATSAPP`, `REVERSE_MATCH`, `CAREER_PAGES`, `ANALYTICS` |
| `source` | SELECT | `WEBSITE`, `MANUAL`, `REFERRAL`, `LINKEDIN`, `EVENT`, `OTHER` |
| `utmSource` | text | |
| `utmMedium` | text | |
| `utmCampaign` | text | |
| `outreachMode` | SELECT | `DRAFT` (default), `AUTO` |
| `sequenceStep` | number | `1` for this milestone |
| `nextFollowUpAt` | date-time | |
| `stopOutreach` | boolean | Hard stop for the worker |

### Task

| Use | Title convention |
| --- | --- |
| Review a generated email | `Review outreach` |
| Human follow-up | `Follow up — {Company}` |

Link through **taskTargets** (`targetOpportunityId` / `targetPersonId` / `targetCompanyId`).

### Note

| Use | Title convention |
| --- | --- |
| Generated email waiting for send | `Outreach draft — {ISO date}` |
| Mail that was actually sent | `Outreach sent — {ISO date}` |
| Inbound reply marker (later) | `Outreach reply-received — {ISO date}` |
| Website research dump | `Research — {domain}` |

Body is markdown (`bodyV2.markdown`). Link through **noteTargets**. The worker embeds a machine footer:

```text
<!-- rb-outreach:opportunity={id}:step={n}:status=draft -->
```

That footer is the idempotency marker (also stored on OutreachJob when the custom object exists).

### OutreachJob (custom object)

Created by seed when Metadata API allows it. If seed cannot create a custom object, skip it and rely on Notes + Opportunity fields.

| Field | Type |
| --- | --- |
| `name` | text (`{opportunityId}:{sequenceStep}`) |
| `opportunityId` | relation → Opportunity |
| `status` | SELECT `QUEUED`, `RESEARCHING`, `DRAFTED`, `APPROVED`, `SENT`, `SKIPPED`, `FAILED` |
| `mode` | SELECT `DRAFT`, `AUTO` |
| `sequenceStep` | number |
| `lastError` | text |
| `idempotencyKey` | text, unique |

## Pipeline stages

Configure on Opportunity `stage` (Settings → Data Model → Opportunities → Stage):

| Value | Label |
| --- | --- |
| `NEW` | New |
| `CONTACTED` | Contacted |
| `QUALIFIED` | Qualified |
| `DEMO_SCHEDULED` | Demo scheduled |
| `DEMO_COMPLETED` | Demo completed |
| `PROPOSAL` | Proposal |
| `NEGOTIATION` | Negotiation |
| `CLOSED_WON` | Closed won |
| `CLOSED_LOST` | Closed lost |

Twenty ships its own defaults. Seed **replaces option labels/values** to this list when the API allows; otherwise rename them in the UI before going live.

## Views (manual in UI)

After fields exist:

1. Opportunities → Kanban on `stage`, name **Sales Pipeline**.
2. Filter `Owner = Me` → **My Pipeline** (unlisted).
3. Table: `nextFollowUpAt` ≤ today, stage not closed → **Follow-ups**.

## Permissions (RB first)

Keep it simple on the first workspace:

- Salespeople: full access to Companies, People, Opportunities they work.
- Do not put the Twenty API key in a browser, Teams, or Webflow.

The outreach worker uses a **server API key** (Settings → APIs & Webhooks). Scope it to a role that can read/write Companies, People, Opportunities, Notes, Tasks, and OutreachJobs.
