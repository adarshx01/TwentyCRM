# Load report

All figures were produced by the repository's own tests/scripts on **one developer workstation** (AMD Ryzen 5 5600H, 12 threads,
22 GB RAM) running application processes, PostgreSQL 16 and the fake Twenty server together. External provider latency
(WhatsApp, Teams, AI, Twenty network time) is **excluded**, matching BRD §10 ("excluding provider network latency"). They show the
architecture has large headroom at the specified envelope; they are **not** a substitute for the pilot load test on the target cloud
(AT-15), which must be run with `load/*.js` (k6) or `scripts/loadgen.mjs` against staging.

## 1. Webhook durable acceptance (real processes, built image layout: `api` + `worker`, direct Postgres)

`scripts/loadgen.mjs` — signed WhatsApp webhooks over HTTP, 3 unknown senders (so the worker path is the cheap "unknown sender" branch).

| Rate | Events | Failed | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| 5 / s × 20 s | 100 | 0 | 12 ms | 39 ms | 59 ms | 59 ms |
| 20 / s × 40 s | 800 | 0 | 22 ms | 29 ms | 55 ms | 57 ms |
| 20 / s × 30 s (CPU run) | 600 | 0 | 24 ms | 32 ms | 77 ms | 90 ms |

Target: p95 < 2 000 ms. **All 900 events** in the first two runs were processed (`inbound_events.processed_at` set) and the queue drained.
Resource use at 20 events/s: `api` ≈ **4.6 %** of one core, `worker` ≈ **9.1 %** of one core, RSS ≈ **160 MB (api)** / **170 MB (worker)**; 49 PostgreSQL connections in total (pool sizes at defaults, 2 processes + queue pools).

## 2. Scaled §10 envelope, in-process e2e (`test/e2e/load-envelope.e2e.spec.ts`)

25 tenants × 25 users = 625 users, real Postgres + pg-boss + workers, fake external systems, one process.

| Scenario | Result |
|---|---|
| Burst 20 events/s for 20 s (400 events, spread over all tenants) | accept p50 26 ms, p95 45 ms, p99 58 ms; **every event answered exactly once**; queues empty 0.2 s after the last event |
| Synchronized morning batch: 625 digests (one task each, live Twenty reads, outbound sends) | claimed 625; all **dispatched in 31.5 s**, all submitted to the (fake) provider in **32.0 s** vs the target "99 % within 10 minutes"; 625 distinct idempotency keys, 625 messages |

The dominant cost in the morning batch is Twenty requests (≈ 3 reads per digest: tasks, people, companies). At the real limit
(≈ 80 requests/min per workspace) a 25-user client needs ≈ 75 requests ≈ 1 minute of one workspace's budget, and clients run in parallel
because budgets are per workspace — which is why the digest uses batched `id in (…)` reads rather than one call per task.

## 3. Behaviour under pressure (e2e tests)

* **Per-workspace protection**: 10 queued CRM operations against one workspace with 120 ms server latency → never more than **2** requests in flight.
* **Request budget**: server limit 100/min, client budget 80/min → 3 captures (≈ 30 requests) completed with **0** responses of 429.
* **Fairness**: tenant A sends 60 uploads + 150 messages in a burst; tenant B's message is answered in ≈ 3.5 s; A's excess uploads are refused with a friendly message and never exceed the per-minute quota in the queue.
* **Restart**: worker killed mid-write → a fresh worker resumes and finishes with no duplicates; graceful shutdown drains in-flight jobs and queued jobs survive.

## 4. Not yet measured (required for sign-off, AT-15)

5 events/s sustained for 30 minutes; 100 simultaneous *real* conversations; Twenty concurrency at its real rate limits; PostgreSQL connection saturation; Redis outage under load (the failure path is verified at unit/integration level); restore drill; tenant relocation rehearsal.
Run: `k6 run load/webhook-burst.js` (5/s for 30 min + 20/s × 60 s burst), `k6 run load/concurrent-sessions.js`.
