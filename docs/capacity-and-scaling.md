# Capacity and scaling

Legend: **[measured]** = produced by this repository's tests/scripts (see `load-report.md`); **[estimate]** = engineering estimate from
those measurements plus stated assumptions, to be replaced by pilot data; **[external]** = depends on a vendor's published limit.

## 1. What actually limits this system

| Rank | Constraint | Why |
|---|---|---|
| 1 | **Twenty request budget per workspace** [external, verify G2/SYNC-04] | Docs state ~100 requests/min and 60 records per batch. A confirmed capture is ≈ 8–12 requests, so a workspace commits only **~6–8 captures/min**; a 25-user client's morning digest needs ≈ 75 reads (≈ 1 min of budget). Language and hardware do not change this. If the limit is per *server* rather than per workspace, 25 clients share ≈ 1.7 req/s and the design must change — check this first |
| 2 | AI provider latency/quotas | Vision/STT/LLM calls are remote I/O (3–30 s). Concurrency needed = rate × latency (Little's law): 20 events/s × ~50 % AI × ~6 s ≈ **60 in-flight calls** at burst; ≈ 15 sustained [estimate] |
| 3 | WhatsApp rules/throughput | 24 h window; one approved template for reminders; Meta fees [external] |
| 4 | Twenty's own database at 100+ workspaces | One schema per workspace in a shared database; group ~100–150 workspaces per Twenty deployment ("cells") [estimate] |
| 5 | Application PostgreSQL | Only after several thousand users [estimate] |
| 6 | Application CPU/RAM | Last [measured: ~5–10 % of a core at 20 events/s] |

## 2. Why TypeScript on one stack (summary of the stack decision)

The BRD workload has no CPU-bound step in the MVP: OCR, speech-to-text and extraction are provider HTTP calls, so the CPython GIL and
benchmark speed differences are irrelevant at 20 events/s (measured: 4.6 % of a core for the API). Node and Python asyncio are both
single-threaded event loops that scale by processes; neither "solves" scalability — the bottlenecks above are external. What differs is
*ownership cost*: Teams tooling is first-class in TypeScript/C# (verify the current Python SDK before relying on it), one Zod contract set serves API,
workers and adapters (a Python AI service would need a second schema system that can drift, a second CI/CD and an extra network hop),
and Twenty itself is TypeScript/NestJS. A hybrid (TypeScript + Python AI worker) becomes worthwhile only on a concrete trigger:
self-hosted STT/OCR (cost crossover roughly at ~10k users), data-residency for extraction, or fine-tuned models. If that happens the seam
already exists (`ExtractionProvider`, Postgres job table, strict JSON contracts); do **not** put both runtimes in one container.

Relative resource footprint at the MVP load [estimate unless noted] — all options sit far inside one 4 vCPU node:

| Stack | API+worker memory (all processes) | CPU at 20 events/s | Note |
|---|---|---|---|
| **TypeScript / NestJS+Fastify (this repo)** | **~0.5 GB** [measured: 160–170 MB per process; 2–3 processes] | **~14 % of one core** [measured, api+worker] | chosen |
| Python / FastAPI + workers | 1.5–3 GB | same order (a few % of a core) | no advantage here; Teams SDK support is strongest for TypeScript/C# (verify current Python status) |
| TS + Python AI service (separate container) | + 150–400 MB | + network hop per extraction | second schema/CI; only after a trigger |
| Go / Java / Rust | 0.3–4 GB | < 1–4 % | no benefit when Twenty and LLM latency dominate |

## 3. Resource model by scale (application tier only; Twenty is sized separately)

| | **MVP** 25 clients / 625 users | **Growth** 100 / 2,500 | **Large** 500 / 10,000+ |
|---|---|---|---|
| Peak inbound events/s (scaled from §10's 20/s) | ~20 | ~80 | ~320–400 |
| Typical in-flight AI calls at peak | ~60 | ~240 | ~1,000+ (provider quota tier!) |
| `api` replicas / `worker` replicas | 2 / 2–4 | 3 / 6–10 | per cell: 3–4 / 8–12; several cells |
| Worker concurrency (per process) | ai 20, crm 10, outbound 15 | same, more replicas | same; split AI workers onto their own pool |
| Application DB | 4 vCPU / 16 GB, < 50 GB | 8 vCPU / 32 GB; partition `audit_log` monthly | 16–32 vCPU; partition by tenant hash; read replica for reporting |
| Connections | ≈ 28 per process × 7 ≈ 200 (direct) | add PgBouncer for `api` | PgBouncer + cell per ~100–150 workspaces |
| Redis | 1–2 GB (limiter only) | 4 GB HA | 8–16 GB HA, or per cell |
| Orchestration | 2 VMs + compose | managed containers for stateless tiers | Kubernetes **per cell** becomes justified |
| Infra cost / month (compute+DB+Redis+LB, GCP list order of magnitude) [estimate] | ~$1,000–1,500 | ~$3,500–6,000 | ~$20,000–40,000 |
| Usage cost (LLM/STT/vision) [estimate] | ~$1–2.5k (≈ $2–4 per active user at 5 captures + 15 messages/day) | ~$4–10k | ~$16–40k |
| Licences/fees | Twenty Organization plan (likely the largest line — get a quote), WhatsApp template fees, Teams free | | |

Infrastructure cost is dominated by the database and Twenty; usage cost scales linearly with users and is comparable to or larger than
infrastructure at every tier — model choice and caching matter more than language. Keep these three buckets (infrastructure /
usage / third-party licences) separate in the client cost model.

## 4. How the code scales each concern independently

* **API/webhooks**: stateless; replicas behind the LB; work done = 1 insert + 1 enqueue.
* **Background jobs**: per-queue pools sized by `WORKER_*_CONCURRENCY`; throughput per poller = batch ÷ poll interval (inbound/outbound batch 10; long jobs batch 1).
* **External API operations**: per-workspace token bucket (80 %) + ≤ 2 concurrent writes; jobs that cannot get budget are re-delayed with jitter, *not* failed.
* **Scheduled jobs**: DB-claimed with `FOR UPDATE SKIP LOCKED`; any number of scheduler instances is safe; reminders paced per tenant.
* **Notifications**: separate outbound queue; WhatsApp template-first outside the window.
* **Reconciliation**: every 5 min per tenant, incremental (`updatedAt ≥ checkpoint − overlap`), plus event-triggered runs.
* **Media**: validated and scanned in the AI pool; private bucket with lifecycle deletion.
* **Backpressure**: tenant quotas (uploads, messages, AI in-flight, reminders), queue depth/age alerts, deferral instead of failure.

## 5. Scaling playbook

1. Alert fires (queue age/CPU/connections). 2. Identify the constrained queue/system (`/health/detailed`, `queue_oldest_job_age_seconds`).
3. Twenty budget? Do **not** add CRM workers — confirm/raise Twenty's limit or reduce reads (digest projection). 4. AI latency? raise AI concurrency / provider tier.
5. API CPU? add `api` replicas. 6. DB connections? PgBouncer for API; reduce pool maxima; right-size.
7. At ~100 clients: move stateless tiers to managed containers; at 500+: cells (workspaces grouped per Twenty deployment; `deployment_id` already routes) and Kubernetes per cell.
Database for 250k opportunities / 1M tasks lives in Twenty's database; our own tables stay small (≈ 11M audit rows/year at 625 users) — partition `audit_log` by month at Growth tier.

## 6. Cloud choice

GCP as preferred by the BRD (Cloud SQL, Memorystore, Secret Manager, GCS). AWS has no decisive technical advantage except zero-risk S3 for Twenty's storage (GCS needs S3-interop testing — do it in G-gates; switch if it fails). OCI is cheapest for compute but its managed PostgreSQL needs validation against the version/extension needs.
