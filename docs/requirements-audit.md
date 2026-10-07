# Requirements audit

Status key — **✅ Verified**: implemented and covered by an automated test that runs against real PostgreSQL/queue with fakes for external systems ·
**🟡 Needs live verification**: implemented and unit/integration-tested, but depends on a live external system or device that could not be exercised here ·
**⚠️ Partial**: part of the requirement is implemented, the gap is stated ·
**❌ Not implemented**.

Test files: `U` = `test/unit/*`, `I` = `test/integration/*`, `E` = `test/e2e/*` (names abbreviated).
Result of the last full run: see the end of this file.

## §2 Architecture and tenant isolation

| Req | Status | Implementation | Verification |
|---|---|---|---|
| Modular app, async workers; LLM proposes, code authorizes | ✅ | `src/*` modules; `common/schemas` (LlmIntent vs AllowedAction) | `U security`, `E prompt-injection` |
| Twenty via supported APIs, no direct DB writes | ✅ | `crm/twenty/*` (REST + metadata) | `I operation-journal` (fake enforces field validity) |
| TEN-01 tenant from verified bindings only | ✅ | `identity/identity.service.ts`, intake routing by authenticated recipient | `I identity-provisioning`, `E prompt-injection`, `I intake-flow` |
| TEN-02 tenant → deployment/workspace registry, relocation-ready | ⚠️ | `tenants.deployment_id/twenty_workspace_id/twenty_base_url` | Relocation procedure documented (`operations.md`), **not rehearsed** (needed for AT-15) |
| TEN-03 tenant scope in rows, queue messages, caches, object keys, audit, idempotency keys; RLS; pool context reset | ✅ | `migrations/0002`, `DbService.tenantTx`, `MediaService` keys, `JobMeta.tenantId`; webhook dedup key is `(channel, provider_event_id)` because the tenant is unknown at acceptance (provider event IDs are unique per channel) | `I tenant-isolation` (non-superuser role, 40 interleaved transactions, no leak) |
| TEN-04 per-workspace credentials; global/per-service pool limits | ✅ | secret refs per tenant; pool sizes per process via env | `I identity-provisioning`, fake Twenty rejects cross-workspace keys |
| TEN-05 quotas and fair scheduling; no public tenant creation | ⚠️ | `QuotaService` (uploads, messages, AI in-flight, reminders), batch inbound, admin-only provisioning | `U limiter`, `E concurrent-operations` (fairness). Inbound queue itself is FIFO; fairness comes from per-tenant quotas, not weighted scheduling |
| Media: private, tenant-separated, expiring access | ✅ | `media/*`, signed URLs ≤ 15 min | `E capture-edge-cases` |

## §3 Data model and configuration

| Req | Status | Implementation | Verification |
|---|---|---|---|
| Entities (Person/Company/Opportunity/Note/Task) incl. E.164 + raw, no invented values, no merge by name | ✅ | `crm-adapter.interface.ts`, `twenty.adapter.ts`, `capture-logic.ts` | `U capture-logic`, `U phone`, `E capture-flow` |
| Meeting requires explicit date+time; date-only follow-ups are not appointments | ✅ | `capture-logic.ts`, `ActionAuthorizer`, `beeHasTime/beeDueDate` | `U capture-logic`, `E capture-edge-cases` |
| CFG-01 ordered stage IDs, labels, terminal won/lost, initial stage, required fields, version | ✅ | `admin/manifest.ts`, `tenant-provisioning.service.ts` | `I identity-provisioning` |
| CFG-02 versioned manifest, idempotent provisioning, documented admin steps | ✅ / 🟡 | `ensureSchema`, `docs/twenty-mapping.md` | `I identity-provisioning` (re-run changes nothing). Live metadata API coverage: G3 |
| CFG-03 timezone, working days, reminder time, currency, teams, mappings, notification destination, channel credentials, retention; secret references | ⚠️ | manifest + tenant settings; notification destination = an employee; dedicated WhatsApp token ref | Teams-channel notification destination and per-client Teams credentials are not implemented |
| CFG-04 stable stage IDs; previewed migration before removal; validate actions against current config | ✅ | provisioning `stageMigrations`/`dryRun`; `ActionAuthorizer` | `I identity-provisioning`, `E crm-operations` |
| Native-object and field mapping delivered | ✅ / 🟡 | `docs/twenty-mapping.md` | Must be re-verified on the pinned release |

## §4 Identity, roles, access

| Req | Status | Implementation | Verification |
|---|---|---|---|
| Role matrix (salesperson/manager/CXO/client admin/operator) and scopes | ✅ | `common/guards/roles.guard.ts`, `common/scope.ts` | `U security`, `E crm-operations`, `I reports` |
| Archive approval manager+; no permanent delete in chat | ✅ | `MutationBuilder`, `beeArchived` | `E crm-operations` |
| Disable permanent destruction for ordinary users in Twenty; document native admin powers | 🟡 | `docs/onboarding-checklist.md` | Twenty-side configuration |
| IAM-01 admin-provisioned binding to verified identity | ✅ | enrollment, `channel_bindings` | `I identity-provisioning` |
| IAM-02 expiring single-use code, approver recorded, unknown senders rejected silently | ✅ | `IdentityService.createEnrollment/redeem` | `I identity-provisioning` |
| IAM-03 Teams tenant+object ID; shared WhatsApp number routes by allow-listed sender, never typed company | ✅ | binding key (channel, connection, external) | `I identity-provisioning`, `I webhook` |
| IAM-04 multiple memberships need explicit selection; sessions separate; drafts bound to tenant/actor/conversation | ✅ | `conversation_sessions`, `workspace` command, draft binding | `I identity-provisioning`, `E capture-flow` |
| IAM-05 revoke/role change blocks commands, confirmations, reminders ≤ 5 min | ✅ | live checks in resolve/commit/deliver; `revokeUser`, `changeRole` | `I identity-provisioning`, `I operation-journal`, `I reminder-scheduling`, `E prompt-injection`, `I webhook` |
| Same scope on search, counts, summaries, cards, media, links, exports, linked records; inaccessible duplicates reveal nothing | ✅ (no export feature exists) | `scopeFilterFor` + post-filter; `DuplicateDetector` hides inaccessible matches | `E capture-edge-cases`, `I reports` |
| Recheck authorization at read and at commit | ✅ | `ActionAuthorizer` in preview, confirm, worker | `E crm-operations` |
| Service key ≠ employee; native UI permissions verified separately | 🟡 | middleware enforces; native RLP is G2 | — |

## §5 Capture journey

| Req | Status | Implementation | Verification |
|---|---|---|---|
| CAP-01 JPEG/PNG + audio, limits (10 MB / 5 min / 20 MB), real type validation, corrupt/unsupported rejected with message | ✅ | `media/mime.ts`, `media.service.ts` | `E capture-edge-cases` |
| CAP-02 draft on first input; ask for context or "continue without a note"; link replies; ask which draft; never attach to "last lead" | ✅ | `ConversationService` | `E capture-flow`, `E capture-edge-cases`, `E chat-guards` (two open drafts → "confirm" asks which; stray text attaches to neither) |
| CAP-03 extract fields with sources; missing stay blank | ✅ | `ExtractionService`, `capture-logic.ts` | `U capture-logic`, `E capture-flow` |
| CAP-04 uncertain/conflicting fields shown; no country-code inference from company; card not replaced silently; clarify target | ✅ | `capture-logic.ts` (`uncertain`, `person_unclear`) | `U capture-logic`, `E capture-edge-cases` |
| CAP-05 relative dates vs sender timezone + message timestamp; absolute date+zone shown; ask when ambiguous | ✅ | `date.util.ts`, `preview.ts` | `U date`, `U capture-logic`, `E capture-flow` |
| CAP-06 normalized email/phone match; name+company possible match; update/create choice; no auto-merge or silent overwrite | ✅ | `DuplicateDetector`, `buildCaptureAction` fill-blanks-only | `U capture-logic`, `E capture-edge-cases` (AT-05) |
| CAP-07 combined preview; Confirm/Edit/Cancel; "not yet saved" | ✅ | `preview.ts` | `E capture-flow` |
| CAP-08 stable reference + authorized link; exact partial status; never announce success early | ✅ | `OperationEffects`, `notifyOutcome/notifyProgress` | `E partial-failure`, `E capture-flow` |
| Extraction evaluation (≥100 cards, ≥50 voice notes, ≥95 % email/phone) | ❌ | Harness `scripts/eval-extraction.mjs` provided | **Not run**: needs the real card/voice corpus and a provider account |

## §6 Operations and confirmation

| Req | Status | Implementation | Verification |
|---|---|---|---|
| Commands: find, move stage, note, task, reschedule, assign, archive, restore | ✅ | `MutationBuilder`, executors | `E crm-operations` (AT-06) |
| ACT-01 preview + confirmation for all chat mutations; reads need none | ✅ | draft state machine | `E crm-operations`, `E capture-flow` |
| ACT-02 draft ID, version, content hash; 30 min expiry after latest edit; valid only for actor/tenant/version/conversation; corrections invalidate old buttons | ✅ | `DraftService`, `ConfirmationService` | `E capture-flow`, `I maintenance`, `I webhook` |
| ACT-03 serialize commits; re-read and re-preview if target/config changed; recheck permissions | ✅ | row lock, `expectedVersion`, `record_changed` flow | `E crm-operations`, `E concurrent-operations` |
| ACT-04 state sequence, source event IDs, stable operation ID | ✅ | `drafts`, `operations` | `E capture-flow` |
| ACT-05 at-least-once handling; dedupe events, confirmations, sends; restart/timeout creates no second operation | ✅ | `inbound_events`, `idempotency_keys`, operation keys, `delivery_state` keys | `I operation-journal`, `E partial-failure`, `E worker-restart`, `I webhook` |
| Multi-record writes via journal; resume missing steps; never roll back by deleting | ✅ | `OperationJournal` | `I operation-journal` (AT-13) |

## §7 Channels

| Req | Status | Implementation | Verification |
|---|---|---|---|
| WhatsApp Cloud API directly | 🟡 | `channels/whatsapp/*` | Tests use recorded fakes; live Meta send/receive not run (G4) |
| WA-01 only onboarded recipients; contact numbers never recipients; shared or dedicated number | ✅ | `OutboundService` (binding lookup only), per-tenant token ref | `U teams-sender` (token selection), `I reminder-scheduling` |
| WA-02 24 h window, template outside, opt-in | ✅ / 🟡 | `OutboundService`, `WHATSAPP_TEMPLATE_NAME` | `I reminder-scheduling` (AT-10). Approval/category/fees are Meta dependencies. Opt-in = enrollment; explicit opt-out tracked via Meta receipts |
| WA-03 minimal template then details after reply; sent/delivered/failed tracked separately | ✅ | `deferredPayload`, `applyReceipt` | `I reminder-scheduling`, `I webhook` |
| TM-01 installable Teams app: private chat + channel messaging; documented Entra registration | ⚠️ | `teams-app/`, `scripts/build-teams-package.mjs`, `docs/onboarding-checklist.md`; channel messages are ingested only on @mention and answered privately | Package builds; **channel-posting of generic notices is not implemented**; install on a tenant not exercised |
| TM-02 conversation references, uninstall/reinstall, multi-tenant auth | ✅ / 🟡 | `webhooks.controller.ts`, `TeamsSender`, `BotFrameworkVerifier` | `I webhook`, `U teams-sender`, `E teams-channel`. JWT verification against live Microsoft keys untested |
| TM-03 private-chat file path; native voice-note limitation disclosed | 🟡 | `TeamsMediaFetcher`, normalizer | `E teams-channel` (fake). Real devices and native voice notes: G4 |
| TM-04 Adaptive Cards; channel reminders only for authorized audiences; mentions explicit | ✅ | `adaptive-cards.ts`; channel messages ignored unless mentioned; a channel never becomes a delivery destination | `U channels`, `E teams-channel`, `I webhook` |

## §8 Reminders and reports

| Req | Status | Implementation | Verification |
|---|---|---|---|
| REM-01 one digest per active salesperson at local start of day; IANA tz; DST-safe | ✅ | `SchedulePlanner`, `date.util.ts` | `U date`, `I reminder-scheduling` |
| REM-02 meetings by time, due today, overdue separate; contact/company/next action/link; no invented time | ✅ | `digest-builder.ts` | `U digest-builder`, `I reminder-scheduling` |
| REM-03 schedule automatically on task create/edit | ✅ | `OperationEffects` → `ensureDigest`; reconciliation for native edits | `I reminder-scheduling` (AT-08) |
| REM-04 one preferred destination; optional dual delivery; Teams channel destination subject to audience rule | ⚠️ | `DigestService` (private chat only) | Teams **channel** destination not implemented (private chat only) |
| REM-05 defaults Mon–Fri 09:00, skip empty, no extra alerts, configurable | ✅ | tenant/user settings | `I reminder-scheduling` |
| REM-06 re-read task state and eligibility; unique key tenant/user/date/type; consolidate | ✅ | `DigestService`, `schedules.idempotency_key` | `I reminder-scheduling` (AT-09) |
| REM-07 capped backoff + jitter; morning cutoff (default 2 h); record failure; no destination switching; no obsolete digests | ✅ | queue retries, cutoff, `no_destination` failure | `I reminder-scheduling` |
| SUM-01 five report types with scope | ✅ | `ReportsService` | `I reports` |
| SUM-02 deterministic totals; period/timezone/scope/time; per-currency | ✅ (LLM narration unused) | `pipeline-calculator.ts` | `U pipeline-calculator`, `I reports` |
| SUM-03 open pipeline definition; won/lost by stage-change date; paginate all; disclose truncation; "no matching records" | ✅ | `ReportsService`, `stage_history` | `I reports` (AT-12) |

## §9 Contracts and synchronization

| Req | Status | Implementation | Verification |
|---|---|---|---|
| Normalized event and strict action contracts | ✅ | `common/schemas` | `U channels`, `U security` |
| `POST /webhooks/whatsapp` verify, dedupe, ack, enqueue; receipts separate | ✅ | `webhooks.controller.ts` | `I webhook` |
| `POST /webhooks/teams` validate activity auth + tenant mapping | ✅ / 🟡 | same | `I webhook` (fake verifier) |
| `POST /drafts/{id}/confirm` actor, version/hash, idempotency key | ✅ | `api.controller.ts` | `I webhook` |
| `POST /drafts/{id}/edit|cancel`, `GET /operations/{id}` scoped | ✅ | same | `I webhook`, `E` |
| `POST /admin/tenants` + configuration (manifest, audit, secret refs, no public signup) | ✅ | `admin/*` | `I identity-provisioning` |
| SYNC-01 Twenty authoritative; no editable pipeline copy | ✅ | live reads; `crm_index` only | — |
| SYNC-02 change events (verify authenticity, re-fetch) + 5-min reconciliation | ✅ / 🟡 | `POST /webhooks/twenty/:slug`, `ReconciliationService`, cron fan-out | `I webhook`, `I reports`, `I reminder-scheduling`. Twenty's exact signature scheme: verify on the pinned release |
| SYNC-03 stage history and won/lost timestamps; no claims for imported records | ✅ | `stage_history`; disclosure in reports | `I reports` |
| SYNC-04 pagination, per-workspace budgets, Retry-After | ✅ / 🟡 | `TwentyClient`, `WorkspaceLimiter` | `U limiter`, `I redis-limiter` (real Redis), `E concurrent-operations`. Rate-limit scope on the pinned release: verify |
| Correlation IDs event → draft → CRM write → reply; concise employee errors | ✅ | `request-context.ts`, jobs carry `correlationId`, audit rows | `E capture-flow`, `I webhook` |

## §10–11 Deployment, security, operations

| Req | Status | Implementation | Verification |
|---|---|---|---|
| Portable containers + IaC on one cloud | 🟡 | `Dockerfile`, compose files, `terraform/` (GCP) | **The Dockerfile was not built here (no Docker daemon available) and Terraform was not applied.** Verified directly instead: `nest build`, migrations as the owner role (idempotent), and four processes (api, worker, scheduler, api) starting concurrently against one database, serving health/admin/metrics, running cron once per minute and exiting cleanly on SIGTERM |
| Two nodes, managed Postgres, Redis-compatible queue, private storage | 🟡 | `terraform/`, `docs/deployment.md` | Reference only |
| Performance targets | ✅ (scaled) / 🟡 | `docs/load-report.md` | Webhook p95 29–45 ms @ 20/s; 625 digests in 32 s. Full 30-min sustained and pilot-cloud runs outstanding |
| 99.5 % availability, RPO ≤ 15 min, RTO ≤ 4 h demonstrated | 🟡 | PITR config, runbook | Restore drill **not performed** |
| SEC-01 TLS, encrypted storage, secret manager; validate signatures/hosts/size/type; no arbitrary URL fetch; scan uploads; no tokens/raw media in logs | ✅ / 🟡 | `media/*`, `logger.ts`, terraform | `U security`, `E capture-edge-cases`. ClamAV is optional until a daemon is configured (fail-closed when configured) |
| SEC-02 untrusted content; no authority from embedded instructions; minimal model context | ✅ | prompts, schemas | `E prompt-injection`, `U security` |
| SEC-03 audit fields; masked logs; journal/audit protected | ✅ | `audit_log` append-only trigger | `I tenant-isolation`, `E capture-flow` |
| SEC-04 retention defaults + automated deletion | ✅ | `MaintenanceService`, media cleanup | `I maintenance`, `E capture-edge-cases` |
| SEC-05 no customer messaging; recipients only employees/internal destinations | ✅ | `OutboundService` | `I intake-flow` (IN-12), `I reminder-scheduling` |
| Health checks, dashboards, alerts (queue age, failures, duplicates, webhook auth errors, token expiry, channel sessions, DB connections, backups, reminder delivery) | ⚠️ | `/health*`, `/metrics`, `ops/prometheus-alerts.yml`, Terraform uptime + DB CPU alerts | No Grafana dashboard JSON shipped; backup-status alert not implemented |
| Usage/cost by tenant | ✅ | `usage_events`, `GET /admin/tenants/{id}/usage`, `tenant_usage_total` | `I maintenance` |
| Backups of CRM, state, media, config; restore to separate env; reconcile incomplete operations | ⚠️ | runbook + PITR | Procedure documented, **not rehearsed** |
| Pinned releases; staging promotion; no auto-upgrade of Twenty; migration rollback docs | ✅ | `docs/deployment.md`, `operations.md` | — |
| Scaling triggers; tenant relocation | ⚠️ | `docs/capacity-and-scaling.md`, relocation runbook | Relocation not demonstrated |

## §16–18 Contact-form email intake

| Req | Status | Implementation | Verification |
|---|---|---|---|
| IN-01 opaque alias per client/form; original preserved | ✅ | `intake_sources.intake_alias`; forwarding doc | `I intake-flow` |
| IN-02 mailbox/folder route with durable checkpoints | ✅ / 🟡 | `MailboxPoller`, `GraphMailboxProvider` | `I intake-flow` (fake provider); live Graph OAuth/shared mailbox/reconnect not run |
| IN-03 signed direct form route | ✅ | `POST /intake/forms/{sourceId}` | `I intake-flow`, `I webhook` |
| Tenant routing by authenticated recipient/mailbox; quarantine unknown/conflicting | ✅ | `IntakeService.receiveEmail` | `I intake-flow` (AT-19) |
| Provider signatures, sender/template rules, rate limits, spam checks, auth evidence | ✅ | webhook HMAC, parser rules, `auth_evidence`, DMARC fail → review | `I intake-flow`, `I webhook` |
| IN-04 safe MIME/HTML, ignore scripts/tracking/quoted text, deterministic mapping first, no URL fetch/attachments | ✅ | `intake-parser.ts` | `U intake-parser` |
| IN-04 optional model extraction with evidence | ⚠️ | `extractEmailFields` provider method + schema exist | Not wired into the pipeline (deterministic mapping only; changed templates go to review) |
| IN-05 form fields (not From); Reply-To only if template says | ✅ | parser | `U intake-parser` |
| IN-06 auto-save minimum; review otherwise | ✅ | `IntakeService.decide` | `I intake-flow` |
| IN-07 integration role; create/link; neutral title; provenance; no overwrite | ✅ | `buildAction`, `integration` authorize | `I intake-flow` |
| IN-08 dedupe by provider event, mailbox ID, submission ID, Message-ID, bounded fingerprint; scoped by tenant/source | ✅ | `isDuplicate` (6 h fingerprint window) | `I intake-flow` (AT-18) |
| IN-09 match by phone/email; ambiguous → review; repeat policy; no company auto-merge | ✅ | `decide` | `I intake-flow` |
| IN-10 designated or atomic round-robin; no owner → admin review; follow-up task/notification after write | ✅ | `AssignmentService`, `onOperationFinished` | `I intake-flow` |
| IN-11 Intake Review object/view in Twenty; chat approval via preview/confirm; poll approved | ✅ / 🟡 | `intakeReview` object, poller, chat `review/approve/reject` | `I intake-flow`, `E intake-review-chat`. View permission restriction is Twenty configuration |
| IN-12 states received→parsed→review/committing→committed/rejected/failed; retries; reconciliation; no visitor messaging | ✅ | `intake_records.state` | `I intake-flow` |

## Acceptance scenarios

| ID | Status | Evidence |
|---|---|---|
| AT-01 isolation (UI, API, search, IDs, media, summaries, stale bindings) | ✅ service-level / 🟡 UI | `I tenant-isolation`, `I webhook`, `I identity-provisioning`; Twenty UI/attachments need G1 |
| AT-02 scope: own/team/CXO; related records, notes, counts | ✅ service-level / 🟡 native UI | `E crm-operations`, `I reports` |
| AT-03 card + voice → one preview → correct → confirm → relations | ✅ | `E capture-flow` |
| AT-04 cancel, timeout, old button, other user | ✅ | `E capture-flow`, `E crm-operations`, `I maintenance` |
| AT-05 same card twice; matches; no silent overwrite | ✅ | `E capture-edge-cases` |
| AT-06 create/search/stage/note/reassign/reschedule/archive/restore | ✅ | `E crm-operations`, `E chat-guards` (reschedule: old/new preview, replacement, digest refresh, ambiguous time asks) |
| AT-07 ambiguous dates, country codes, noisy audio | ✅ | `U capture-logic`, `E capture-edge-cases` (scripted model; real audio quality is G4/eval) |
| AT-08 Twenty-edited tasks in next digest; completed/archived/reassigned removed; midnight/DST/non-working | ✅ | `I reminder-scheduling`, `U date` |
| AT-09 job runs twice/restarts; ambiguous sends reconciled | ✅ | `I reminder-scheduling` |
| AT-10 template outside window; rejection; opt-out; blocked | ✅ (fake provider) | `I reminder-scheduling`, `I webhook` |
| AT-11 Teams private card/audio, proactive delivery, audience rule, uninstall | ✅ (fake) / 🟡 devices | `E teams-channel`, `U teams-sender`, `I webhook` |
| AT-12 pipeline & won totals across pagination and currencies | ✅ | `I reports` |
| AT-13 Twenty timeout after create; worker restart; no duplicates; accurate partial report | ✅ | `I operation-journal`, `E partial-failure`, `E worker-restart` |
| AT-14 revoke with pending draft/reminder; injection | ✅ | `E prompt-injection`, `I identity-provisioning` |
| AT-15 load envelope, restore within RPO/RTO, tenant relocation in staging | ⚠️ | Scaled load run (`docs/load-report.md`); restore drill and relocation **not done** |
| AT-16 unchanged form email → correct records ≤ 5 min | ✅ | `I intake-flow` |
| AT-17 HTML/plain/international/website From | ✅ | `U intake-parser`, `I intake-flow` |
| AT-18 mailbox retries, duplicate webhook, forwarded copies; repeat policy | ✅ | `I intake-flow` |
| AT-19 spoof, unknown route, malformed, changed template, injection | ✅ | `I intake-flow` |
| AT-20 review: missing/conflicting; authorized approval once; rejection; restricted users | ✅ | `I intake-flow`, `E intake-review-chat` |
| AT-21 owner/stage/source/task/notification; disabled options; no visitor message | ✅ | `I intake-flow` |
| AT-22 expired token, missed event, CRM outage → replay without loss/duplicates; operator alert | ✅ (alert = metric/health, not a paging integration) | `I intake-flow` |

## Deliverables (§13)

| Deliverable | Status |
|---|---|
| Source, container definitions, IaC, deployment instructions, env reference, dependency inventory | ✅ (`package.json` + lockfile pin dependencies; no separate licence inventory generated — run `pnpm licenses list`) |
| Provisioning manifest + scripts, native mapping, pipeline templates, roles/teams, onboarding/offboarding | ✅ |
| OpenAPI, channel event mappings, action schemas, operation state machine, migrations, provider setup guides, Teams app package | ✅ (provider setup guides are condensed in `deployment.md`/`onboarding-checklist.md`) |
| Automated tests with fixtures and results; device/media matrix; extraction evaluation; load report; backup/restore + relocation runbooks; monthly cost model | ⚠️ tests/fixtures/results ✅, load report ✅ (scaled), runbooks ✅ (**not rehearsed**), cost model = order-of-magnitude in `capacity-and-scaling.md` (needs pilot data); device matrix and extraction evaluation **not produced** |

## What could not be implemented or verified, and why

1. **Anything requiring a live external system**: Twenty (real API behaviour, RLP, rate-limit scope), WhatsApp (real number, template approval), Teams (real tenant/devices), AI providers (accuracy), GCP (Terraform), Microsoft Graph mailbox. No such accounts/credentials exist in this environment; the integrations are implemented to the boundary and tested against protocol-level fakes.
2. **Extraction accuracy evaluation, restore drill, tenant-relocation rehearsal, 30-minute sustained load** — require real data/infrastructure and time; harnesses and runbooks are provided.
3. **Teams channel destination for reminders/notifications**, per-client Teams credentials, model-assisted email extraction, Grafana dashboard JSON, backup-status alert — not built; see rows above.
4. **Native Twenty UI permissions (G2)** — a Twenty-side configuration and licensing decision.
