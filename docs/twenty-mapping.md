# Twenty object and field mapping

> **Status: implemented against the Twenty REST/metadata shapes the adapter assumes; MUST be verified on the pinned Twenty
> release (feasibility gates G2/G3).** The adapter is isolated in `src/crm/twenty/` so a mismatch is a localized fix. The
> in-repo `test/helpers/twenty-fake.ts` mirrors these shapes and enforces them (unknown fields are rejected, so un-provisioned
> custom fields fail loudly in tests).

Authentication: per-workspace API key resolved from a secret reference. Base URL: `tenants.twenty_base_url`
(workspace sub-domain), falling back to `TWENTY_API_URL`. REST: `/rest/<objects>` with `filter`, `limit` (≤ 60) and
`starting_after` pagination; metadata: `/rest/metadata/objects|fields`.

## Native objects

| Domain | Twenty object | Native fields used |
|---|---|---|
| Person | `person` (`/rest/people`) | `name{firstName,lastName}`, `emails.primaryEmail`, `phones.primaryPhoneNumber`, `jobTitle`, `companyId` |
| Company | `company` | `name`, `domainName.primaryLinkUrl`, `address.addressStreet1/addressCountry` |
| Opportunity (“lead”) | `opportunity` | `name`, `amount{amountMicros,currencyCode}`, `closeDate`, `stage` (SELECT), `pointOfContactId`, `companyId` |
| Note | `note` + `noteTarget` | `title`, `bodyV2.markdown`; targets link person/company/opportunity |
| Task / meeting | `task` + `taskTarget` | `title`, `status` (TODO/DONE), `dueAt`; targets link person/company/opportunity |

A custom **Meeting** object is *not* needed: tasks carry `beeTaskKind = meeting`, an explicit `dueAt` and `beeHasTime = true`.

## Custom fields provisioned by `ensureSchema` (idempotent, CFG-02)

| Field | On | Purpose |
|---|---|---|
| `beeOperationKey` | all | `<operationId>:<stepKey>` — recover records after timeouts, dedupe replays (ACT-05) |
| `beeOwnerMemberId`, `beeTeamId` | all | Owner/team used for server-side scope filters (Section 4) |
| `beeArchived` (default false) | all | Recoverable archive/restore; there is no hard delete |
| `beeSource`, `beeSourceEventIds` | all | Provenance (channel, source message IDs) |
| `beePhoneE164`, `beePhoneRaw`, `beePhoneDigits` | person | E.164 + preserved raw input + digit key for matching (CAP-03/06) |
| `beeInterest`, `beeLostReason` | opportunity | Interest; lost reason |
| `beeNoteType`, `beeEventTime`, `beeChannel`, `beeAttachmentRefs` | note | Observation vs transcript, event time, channel, media references |
| `beeTaskKind`, `beeStatus`, `beeDueDate`, `beeHasTime`, `beeTimezone`, `beeDurationMin`, `beeLocation`, `beeCompletedAt` | task | Kind, cancelled state, **local date** (date-only follow-ups are not appointments), timezone, duration/location |
| `beePersonId`, `beeCompanyId`, `beeOpportunityId` | task | Denormalized links so tasks can be filtered server-side; native `taskTarget` rows are written too |

## Pipeline

`opportunity.stage` SELECT options are set from the manifest: option value = `UPPER(stage id)`, label = stage label.
Stable stage IDs never change when labels change (CFG-04). Stages not in the manifest are **kept** and reported as warnings;
removing a stage that has records needs a previewed migration (`stageMigrations`, `?dryRun=true`).

## Intake review

Custom object `intakeReview` (`beeRecordId`, `beeSourceId`, `beeStatus`, `beeReason`, `beeFields`, `beeOperationRef`,
`beeReviewedBy`, `beeReceivedAt`). Approved/rejected rows are polled and executed idempotently (IN-11). Restricting the view
to managers/admins is a **Twenty permission configuration** (see onboarding checklist).

## Known gaps to close in feasibility

1. **Row-level permissions in the native UI (G2).** Server-side scope is enforced in this service on every read/write, but
   Twenty's UI is a second route to records. Native RLP must be configured against `beeOwnerMemberId`/`beeTeamId` (or a
   relation to workspace members) and licensed (Organization plan). Do not release with middleware-only filtering.
2. REST filter grammar, batch endpoints and the rate-limit **scope** (per workspace vs per key vs per server) must be
   confirmed; `TWENTY_API_RATE_LIMIT` and `TWENTY_MAX_CONCURRENT_WRITES` are the knobs.
3. Native assignee (`assigneeId`) is not populated; ownership uses `beeOwnerMemberId`. Map to workspace members if the UI
   needs "My tasks" views.
4. Change events: `POST /webhooks/twenty/:tenantSlug` verifies an HMAC over `<timestamp>:<body>` (confirm Twenty's exact
   signing scheme on the pinned release) and triggers a reconciliation; the 5-minute poll remains the safety net.
