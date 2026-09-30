# Request path

```text
verify webhook
  → persist and dedupe provider message id
  → resolve membership from channel binding
  → extract a typed action proposal
  → preview draft (version + content hash, 30-minute expiry)
  → confirm (role check again)
  → journaled CRM writes, resumable
```

## Draft states (ACT-01–05)

| State | Meaning |
| --- | --- |
| `collecting` | No valid proposal yet (plain text, no card) |
| `awaiting_confirmation` | Proposal is valid; waiting for the actor |
| `committing` | Journal is running |
| `committed` | Journal finished; a repeat confirm with the same version and hash returns the same operation |
| `cancelled` | Actor cancelled before commit; confirm is rejected |
| `expired` | `expires_at` passed (30 minutes after the draft became confirmable) |
| `needs_repair` | Journal failed part-way, or the proposal was rejected; completed steps stay |

Each confirmable draft stores:

- `version` — incremented when the payload changes
- `content_hash` — SHA-256 of canonical JSON
- `manifest_version` — copied from the tenant at create time (CFG)
- `expires_at` — 30 minutes from the transition to `awaiting_confirmation`

Confirm requires the version and hash the user saw. A mismatch is a conflict, not a silent overwrite. Replay of a successful confirm does not create a second Person, Company, or Opportunity. Cancel is allowed from `awaiting_confirmation` and `collecting`. The wrong actor is forbidden (AT-04).

## Journal

Steps, in order: `company` (optional), `person`, `opportunity`, `note` (optional), `task` (optional).

Rules:

- Match Person on email and Company on domain before insert.
- Never delete an existing Twenty record. There is no delete method on the client used by the journal.
- A failed step is marked `failed` with an error string. Earlier steps stay `completed` with their Twenty ids.
- Resume runs only steps that are not `completed` or `skipped` (AT-13).
- Idempotency key: `draft:{id}:v{version}:{content_hash}`.

## Stage and fields (AT-06, AT-07)

Stages are stable ids in manifest `2026.1` (the Recruitment Bricks pipeline: `NEW` through `CLOSED_LOST`). Any other stage is rejected before a CRM call.

The proposal schema forbids unknown keys. `tenant_id` on a card is stripped and ignored, not stored as a CRM field. Nested invented fields (for example `favoriteColor`) fail validation. They are not forwarded to Twenty.

## Reminders (REM-01–07)

The planner builds a per-membership digest from task payloads:

- Only that membership’s tasks (REM-03).
- Buckets: overdue, today, upcoming seven days (REM-02).
- Closed stages `CLOSED_WON` and `CLOSED_LOST` are omitted (REM-04).
- One schedule per membership per UTC day (REM-05).
- Dispatch goes through a channel port, not a direct Graph or WhatsApp call (REM-06).
- A failed send leaves the schedule `pending` and does not delete tasks (REM-07).

Digest text is an outbox row. Dispatch uses the channel port. WhatsApp sends a template outside the 24-hour window and session text inside it. Teams sends a proactive activity to the stored personal-chat reference. If credentials are missing the schedule stays `pending` and records `last_error`. It is not marked sent.
