# BRD compliance report — 2026-10-11

Scope: *Conversational CRM engineering requirements v1.1* against the code in this repository, the local stack (Twenty
v2.45.6 ×2 + Bee + LangChain agent) and the AWS deployment. Status words are used strictly:

* **PASSED** — executed in this review, with the evidence named.
* **FAILED** — executed and did not meet the requirement (none open at the end; those found are listed under *Defects*).
* **BLOCKED** — cannot be executed here: needs an external account, device or corpus (named).
* **UNTESTED** — executable in principle, not executed in this review.

## 1. Defects found, root causes, fixes

| # | Symptom | Root cause | Fix | Regression test |
|---|---|---|---|---|
| D1 | A salesperson's Bee page said "not linked" / showed the service account as their Twenty account | The link list offered **every** Twenty member, including Bee's own service user; an admin could link an employee to it | Service user is never listed, suggested or linkable (409) | `twenty-access.spec` "service account is not listed… cannot be linked" |
| D2 | New employee could not get in ("User does not have access to this workspace") | Public sign-up is correctly **off**; nothing invited the person | "Add user" now invites the e-mail into Twenty (as *No access*); accepting auto-links, role is assigned | `twenty-access.spec` invitations (2 tests); live invite → accept → link → login |
| D3 | Integration key held Twenty's full **Admin** role | Bootstrap created it as Admin; BRD §4 forbids the service identity from bypassing employee permissions | Dedicated `Bee · Integration` role (records + schema, no destroy/roles/settings), assigned via the service user | `twenty-access.spec` integration role; live: key gets PERMISSION_DENIED on roles |
| D4 | Default role for new Twenty members was *Member* (read/update/**destroy** everything) and the public invite link was on | Twenty defaults | Default role → *Bee · No access*; invite link and impersonation off; re-applied every sync | `twenty-access.spec` hardening; live workspace settings |
| D5 | A read-only question was refused while any draft was open | Free-text router treated every non-edit text as "stray text" | Searches and reports are answered; drafts untouched | `chat-guards.e2e` read-while-draft-open |
| D6 | Fresh Ask AI thread: "confirm" was not forwarded | The model has no context in a new thread | Skill rule + **drafts card on the Bee page** (Confirm/Cancel through the same confirmation contract) | `chat-guards.e2e` page confirm (stale/duplicate/once) |
| D7 | Role changes made natively in Twenty persisted | No reconciliation of native roles | Sync re-applies Bee's roles every reconciliation; drift reported | `twenty-access.spec` drift revert |
| D8 | Local and AWS workers consumed each other's jobs | Both used one Postgres (shared outbox) | Local has its own Postgres | observed fix; AWS e2e capture after the split |
| D9 | Reminder tests failed outside Indian morning hours and on weekends | Tests used wall-clock "today" | Clock- and weekday-independent | `reminder-scheduling.spec` |
| D10 | `.env.local` could not be sourced after a value with a space | Unquoted `EMAIL_FROM_NAME` | Quoted | — |

Earlier in the engagement (already fixed, kept for the record): tool relay used the worker's `localhost`; stale button ids
looped the assistant; the "Saved" outcome never reached `web`/`dev` channels; owner key changed when linking a member.

## 2. Roles and tenancy (BRD §4, TEN-*)

Design: `docs/access-architecture.md`. Evidence:

| Check | Result | Evidence |
|---|---|---|
| Four tenant roles with an explicit permission matrix; operator is a separate principal | PASSED | `security.spec` (matrix), DB check constraint |
| Salesperson: own records only; manager: own + assigned teams; CXO/admin: company | PASSED | Live role matrix 16/16 (real Twenty logins); `access-control.spec`; `reports.spec` |
| Native Twenty UI/API: salesperson & manager denied records; CXO reads all, cannot destroy | PASSED | Live: REST/GraphQL return PERMISSION_DENIED; CXO `destroyOpportunity` denied, soft-delete allowed |
| Bee admin API denied to salesperson/manager/CXO, open to client admin | PASSED | Live matrix + `access-control.spec` |
| Integration identity does not bypass employee permissions | PASSED | Live: key lacks role management; Bee applies the employee's scope on every call |
| Two independent clients: records, users, pipeline, config, credentials | PASSED | Live isolation 20/20 across two real Twenty instances; `tenant-isolation.spec` (RLS, runtime role not superuser) |
| Cross-tenant IDs / secrets / member ids / sessions / keys | PASSED | Live isolation (401/403/404) |
| Support access only with client approval, time-boxed, audited | PASSED | `access-control.spec` operators |
| Revocation / role change takes effect immediately; drafts and reminders stop | PASSED | `access-control.spec`, `identity-provisioning.spec`, `twenty-access.spec` |
| Multiple memberships (workspace selection, separate sessions) | PASSED | `identity-provisioning.spec` |
| Single Twenty instance in multi-workspace mode with subdomains | UNTESTED | Deferred by decision; isolation proven with separate instances instead |
| Twenty row-level permissions for salesperson/manager screens | BLOCKED | Needs an Organization licence key; decision: those roles are Bee-only (no record screens) |

## 3. Acceptance scenarios AT-01 … AT-22

| ID | Status | Evidence / gap |
|---|---|---|
| AT-01 isolation (UI, API, search, IDs, media, summaries, stale bindings) | **PASSED** | Live isolation 20/20; `tenant-isolation`, `webhook`, `access-control` specs |
| AT-02 scope: own / team / CXO; related records, counts | **PASSED** | Live role matrix; `crm-operations.e2e`, `reports` |
| AT-03 card + voice → one preview → correct → confirm → relations | **PASSED** (fakes for extraction) / text via real agent **PASSED** live / real devices **UNTESTED** | `capture-flow.e2e`; live Ask AI capture in both clients |
| AT-04 cancel, timeout, old button, other user | **PASSED** | `capture-flow`, `crm-operations`, `maintenance`, `chat-guards` |
| AT-05 same card twice; matches; no silent overwrite | **PASSED** | `capture-edge-cases.e2e`; live duplicate prompts |
| AT-06 create/search/stage/note/reassign/reschedule/archive/restore | **PASSED** | `crm-operations.e2e`, `chat-guards`, archive-request flow |
| AT-07 ambiguous dates, country codes, noisy audio | **PASSED** (scripted) / noisy real audio **BLOCKED** (needs recordings) | `capture-logic`, `capture-edge-cases` |
| AT-08 Twenty-edited tasks in next digest; DST; non-working days | **PASSED** | `reminder-scheduling` (weekend-proof) |
| AT-09 job twice / restart | **PASSED** | `reminder-scheduling` |
| AT-10 WhatsApp template outside window; rejection; opt-out | **PASSED** (fake provider) / Meta approval **BLOCKED** | `reminder-scheduling`, `webhook` |
| AT-11 Teams private card/audio, proactive, audience rule | **PASSED** (fake) / devices **BLOCKED** | `teams-channel.e2e`, `teams-sender` |
| AT-12 pipeline & won totals across pagination and currencies | **PASSED** | `reports` |
| AT-13 Twenty timeout after create; restart; no duplicates | **PASSED** | `operation-journal`, `partial-failure`, `worker-restart` |
| AT-14 revoke with pending draft/reminder; injection | **PASSED** | `prompt-injection.e2e`, `identity-provisioning`, `access-control` |
| AT-15 load envelope; restore ≤ RPO/RTO; tenant relocation | scaled load **PASSED** (`docs/load-report.md`); restore drill and relocation **UNTESTED** | needs staging infrastructure |
| AT-16 unchanged form e-mail → records ≤ 5 min | **PASSED** (fake mailbox) / live Graph **BLOCKED** | `intake-flow` |
| AT-17 HTML/plain/international/website From | **PASSED** | `intake-parser`, `intake-flow` |
| AT-18 retries, duplicate webhook, forwarded copies, repeat policy | **PASSED** | `intake-flow` |
| AT-19 spoof, unknown route, malformed, changed template, injection | **PASSED** | `intake-flow` |
| AT-20 review: missing/conflicting; authorized approval once; rejection; restricted users | **PASSED** (now also scoped to the manager's teams; Twenty-side approvals count only for linked, authorized members) | `intake-flow`, `intake-review-chat.e2e` |
| AT-21 owner/stage/source/task/notification options | **PASSED** | `intake-flow` |
| AT-22 expired token, missed event, CRM outage → replay | **PASSED** (alert = metric/health, no pager integration) | `intake-flow` |

## 4. Test results (this review)

| Suite | Result |
|---|---|
| Unit (`npx vitest run`) | 140 / 140 passed |
| Integration (`--config vitest.integration.config.ts`) | 131 / 131 passed (reminder-scheduling 19; access-control 15; twenty-access 10) |
| End-to-end (`--config vitest.e2e.config.ts`) | 59 / 59 passed |
| Live role matrix (`scripts/verify/role-matrix.mjs`) | 16 / 16 passed |
| Live two-client isolation (`scripts/verify/isolation.mjs`) | 20 / 20 passed |
| Lint / type-check | clean |

## 5. Remaining gaps and external dependencies

1. **WhatsApp Meta Cloud API, Microsoft Teams, Microsoft Graph mailbox** — code and fakes tested; live accounts needed (G4/IN-02).
2. **Extraction accuracy evaluation** (≥100 cards, ≥50 voice notes, ≥95 % e-mail/phone) — harness `scripts/eval-extraction.mjs`; corpus needed.
3. **Restore drill, tenant relocation rehearsal, 30-minute sustained load, 99.5 % availability** — need staging infrastructure.
4. **REM-04 Teams *channel* destination for digests** — private chat only; the audience-rule notice is not implemented.
5. **TEN-05 fair scheduling** — quotas and batching exist; the inbound queue itself is FIFO.
6. **IN-04 optional model extraction for changed templates** — deterministic parser only (changed templates go to review, as the BRD allows).
7. **Twenty multi-workspace mode on AWS and the operator console workspace** — deferred by decision.
8. **Outbound SMTP from the developer machine is blocked**; Gmail SMTP is configured for AWS and credentials must be verified there (see deployment notes).
9. Ask AI cannot be forced to forward a bare "confirm" in a **new** conversation; the Bee page shows and confirms open drafts instead.
