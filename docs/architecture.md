# Architecture and decisions

## 1. Shape of the system

```
 WhatsApp Cloud API ─┐                                    ┌─► Twenty (per-client workspace, system of record)
 Microsoft Teams ────┼─► API role ──► Postgres ◄── pg-boss ┤
 Email / forms ──────┘  (verify,       (state +    queues  ├─► AI provider (vision, STT, structured extraction)
                         persist,       journal)     │     ├─► WhatsApp / Teams (outbound)
                         enqueue)                    ▼     └─► Object storage (private media)
                                              WORKER role pools
                                    inbound · ai · crm-write · outbound · reminder · intake · reconciliation
                                              SCHEDULER role (cron producers)
```

* **Twenty** holds contacts, companies, opportunities, notes and tasks (SYNC-01). We keep only operational state and an
  index (`crm_index`, `stage_history`) — never an editable copy of the pipeline.
* **Application PostgreSQL** holds the tenant registry, identity bindings, drafts, operation journal, outbox/delivery
  state, schedules, audit trail and the durable queue. It is separate from Twenty's database.
* **Queue**: pg-boss on the same PostgreSQL. State change and job enqueue commit in **one transaction**, so there is no
  "saved but never queued" window. Redis carries only token buckets and short leases; losing it loses no business state.

## 2. Request lifecycle (chat capture)

1. `POST /webhooks/whatsapp|teams` verifies the provider signature/JWT, normalizes the payload, inserts `inbound_events`
   (unique `(channel, provider_event_id)`) and enqueues — then returns 200. No business logic runs here.
2. An inbound worker resolves **tenant + user from the verified channel binding** (never from text), then routes:
   command / clarification / edit / confirmation / new capture / query.
3. Media jobs run in the AI pool: download from an allowlisted host → magic-byte type check → size/duration limits → scan →
   store under `tenants/<id>/…` → extract → merge into the draft → ask for what is missing or show **one combined preview**.
4. Confirmation (`draftId + version + content hash`, actor, conversation) atomically moves the draft to `committing`,
   creates the **operation** and enqueues it. The CRM worker executes journaled steps and reports exactly what was saved.

## 3. State machines

Draft: `collecting → awaiting_confirmation → committing → committed | cancelled | expired | needs_repair`
(terminal states are guarded by a DB trigger). Each content change bumps `version` and changes `content_hash`, which
invalidates older buttons. Drafts expire 30 minutes after the latest edit.

Operation: `pending → in_progress → committed | failed | needs_repair`, with per-step status
`pending → in_progress → committed | failed`. A step is journaled `in_progress` *before* the CRM call and `committed`
after it. Every CRM create first looks up `beeOperationKey = <operationId>:<stepKey>`; after a timeout or restart the
retry finds the record that was created and continues instead of duplicating it (ACT-05, AT-13). Nothing is rolled back
by deleting records; partial results stay auditable and an operator can replay only the missing steps.

## 4. Decision records

| # | Decision | Why | Revisit when |
|---|---|---|---|
| D1 | **TypeScript end to end** (NestJS on Fastify) — supersedes the BRD's FastAPI suggestion | The BRD's AI is managed-provider HTTP calls (no GIL/CPU argument for Python). Teams has first-class TypeScript support; one language and one set of Zod contracts across API, workers and adapters is the largest long-run maintainability win. The BRD states FastAPI as a proposed design, not a confirmed requirement. | Self-hosted STT/OCR or fine-tuned models are required (add a Python worker behind the `ExtractionProvider` interface, reading an `ai_jobs` table) |
| D2 | Postgres-native queue (pg-boss) instead of Redis/BullMQ | Journal, drafts and outbox must be in Postgres anyway; transactional enqueue removes a failure window; one fewer durable system. Throughput needed (≤ ~400 jobs/s) is far below pg-boss limits | Sustained > ~1–2k jobs/s or a team standard on a broker |
| D3 | Row-level security with `set_config('app.tenant_id', $1, true)` per transaction | Defence in depth (TEN-03). Transaction-local setting is safe under PgBouncer transaction pooling. Tests run as a non-superuser role and verify no context leak | — |
| D4 | CRM port (`CrmAdapter`) + Twenty adapter; custom `bee*` fields for owner, team, archive, operation key | Twenty upgrades must not touch domain code; archive is a recoverable flag, never a hard delete; the operation-key field makes creates idempotent | A Twenty release supplies native equivalents |
| D5 | Archive = `beeArchived` flag | BRD: recoverable archive, no permanent delete in chat | — |
| D6 | LLM schema (`LlmIntentSchema`) is separate from the executable `AllowedActionSchema` | A model can express free text only. Record IDs, owners, tenants and roles are chosen by server code after authorization (SEC-02) | — |
| D7 | Teams via Bot Framework REST + Adaptive Cards (not an SDK) | Fewer moving parts for a small surface (receive activity, send card, proactive message); JWT validated with `jose` | Microsoft ships a stable multi-tenant TypeScript SDK that removes code |
| D8 | No Kubernetes at MVP; two VMs + managed Postgres/Redis | See `docs/capacity-and-scaling.md` | ≥ ~100 clients / 2,500 users |
| D9 | Reads from Twenty are always live and scoped; `crm_index` only drives reconciliation/history | SYNC-01 | Digest/report volume exhausts Twenty's request budget (then add a read-only projection, confirm with client) |

## 5. Failure model (what happens when…)

| Failure | Behaviour |
|---|---|
| Webhook delivered twice / replayed | Unique `(channel, provider_event_id)`; second is acknowledged and dropped |
| Confirm clicked twice / racing | Row lock + `confirm:<draft>:<version>` operation key → one operation, same result returned |
| Worker killed mid-write | Job returns to the queue; operation lease expires; next worker resumes missing steps; lookup by operation key prevents duplicates |
| Twenty timeout after a successful create | Step stays `in_progress`; retry finds the record by key |
| Twenty 429 / rate budget | Job re-delayed (not failed); per-workspace token bucket at 80% of the published limit; ≤ 2 concurrent writes per workspace |
| Twenty down for all retries | Dead-lettered; user told exactly what was saved/not; operator replays only missing steps |
| AI provider timeout/invalid output | Strict schema validation, one repair retry, then retry/dead-letter; the draft stays and the user is told |
| Redis down | Limiter fails **closed** to a conservative local limit; no business state lost |
| Database failover | Pools reconnect; queue/journal are in Postgres; in-flight jobs resume after lease expiry |
| WhatsApp send timeout | Row becomes `ambiguous` and is **not** blindly resent; operators reconcile |
| Revoked user | Next read/commit/delivery re-checks the live user; drafts cancelled, schedules skipped, bindings revoked |
| Deploy / SIGTERM | Stop HTTP, finish in-flight jobs (≤ 25 s), stop claiming, exit |

## 6. Concurrency model (explicit)

* One draft: serialized with `SELECT … FOR UPDATE`; optimistic version on conversation advance.
* One operation: lease (`lease_owner`, `lease_until` 90 s, renewed per step); takeover only after expiry.
* Twenty workspace: ≤ `TWENTY_MAX_CONCURRENT_WRITES` (2) in-flight write operations and a request token bucket
  (`TWENTY_API_RATE_LIMIT`, default 80/min), both shared via Redis across processes.
* Tenant fairness: per-tenant upload quota, per-tenant AI in-flight cap, per-tenant message quota and reminder pacing.
* Queue pollers: throughput per poller = batch ÷ polling interval; fast queues batch, long jobs do not.
