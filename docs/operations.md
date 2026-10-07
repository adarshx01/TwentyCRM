# Operations runbook

## Dashboards and alerts
Scrape `/metrics` (Prometheus text). Alert rules: [`ops/prometheus-alerts.yml`](../ops/prometheus-alerts.yml). Key series:
`queue_depth`, `queue_oldest_job_age_seconds`, `queue_jobs_total{result}`, `webhook_received_total`, `webhook_accept_duration_seconds`,
`webhook_auth_failures_total`, `duplicate_suppressed_total`, `draft_state_transitions_total`, `crm_operations_total{result}`,
`twenty_api_calls_total{status}`, `twenty_api_rate_limit_delays_total`, `reminder_dispatch_total{result}`, `reminder_dispatch_delay_seconds`,
`outbound_messages_total{result}`, `dead_letters_total`, `channel_connection_health`, `intake_records_total{result}`, `tenant_usage_total{kind}`.
`GET /health/detailed` (admin key) returns queue depths/ages, open dead letters, overdue schedules, ambiguous sends, mailbox health, intake backlog and DB connection count.
Per-tenant usage (tokens, STT seconds, vision calls, media bytes) is in `usage_events`.

## Sizing and scaling knobs (in this order — BRD §11)
1. Tune queries/indexes and per-workspace budgets. 2. Pool sizes and worker concurrency. 3. Scale shared services.
Triggers for investigation: DB connections or CPU > 70 % for 15 min, p95 above target, oldest interactive job > 60 s, repeated morning-dispatch misses, one client > 25 % of capacity.
Throughput per poller = batch ÷ `WORKER_POLL_INTERVAL_SECONDS`: raise concurrency before lowering the interval.

## Runbooks

**Queue backlog growing** — `GET /health/detailed` → which queue? `crm-write`: check `twenty_api_rate_limit_delays_total` (budget) and Twenty health; raising CRM concurrency does **not** help beyond 2 writes/workspace. `ai-extraction`: provider latency/quota; per-tenant AI cap (`quotaLimits.maxAiJobsInFlight`). `inbound-event`: add worker replicas.

**Dead letters** — `GET /admin/dead-letters`. For `crm-write` (partial operation): fix the cause (e.g. Twenty down, field rejected), then `POST /admin/dead-letters/{id}/retry`. The operation is reopened and **only missing steps run**; committed steps are never repeated. Use `…/resolve` for items handled by hand. Payloads are redacted of text/transcripts.

**Operation stuck `in_progress`** — leases expire after 90 s; if the job is lost, the queue's expiry (300 s) returns it. Force: `UPDATE operations SET lease_until = now() - interval '1 s' WHERE id = …` (as owner) and re-enqueue via dead-letter retry or wait for the retry.

**Ambiguous WhatsApp sends** (`delivery_state.status = 'ambiguous'`) — outcome unknown: check Meta's message status/webhook receipts for the timestamp; if not delivered, insert a new delivery with a new idempotency key. They are never auto-resent.

**Token expiry / disconnected channel** — WhatsApp: `channel_connection_health{channel="whatsapp"} = 0`, sends return `retryable` every minute: rotate `WHATSAPP_ACCESS_TOKEN` (Secret Manager) and restart. Mailbox: `mailbox_checkpoints.health = token_expired`; renew the OAuth token; polling resumes from the checkpoint (no loss, replay is idempotent).

**Failed intake / parser** — `intake_records.state = 'failed' | 'review'`. Changed template → update `parsingRules` (new `parserVersion`) and re-run: `POST /intake/review/{id}/approve` (or reprocess keeps `operation_id` `intake:<id>`).

**Revoke an employee** — `POST /admin/tenants/{t}/users/{u}/revoke`: blocks commands, pending confirmations, queued/future reminders (within seconds; BRD ≤ 5 min).

**Rotate secrets** — update the Secret Manager version; the in-process cache lasts 5 min (`SecretResolver`). Webhook secrets: rotate provider and secret together.

**Reconcile now** — `POST /admin/tenants/{id}/reconcile`.

## Backup and recovery (RPO ≤ 15 min, RTO ≤ 4 h)
* **What**: Application DB (journal, drafts, audit, schedules, config), Twenty DB, media bucket, secrets, Terraform state, manifests.
* **How**: Cloud SQL automated backups + point-in-time recovery (WAL; Terraform enables it, 14 backups, 7-day log retention).
  Bucket: enable object versioning if the client policy requires (default retention deletes media at 24 h / 30 d by design).
  Export manifests with `GET /admin/tenants` + the stored provisioning manifests in version control.
* **Restore drill (do before go-live, AT-15)**: 1) clone the instance to a *separate* environment at a chosen timestamp; 2) restore media;
  3) start `api/worker` against the clone with **`APP_ROLE=api` only first**; 4) run `POST /admin/tenants/{id}/reconcile` for every tenant;
  5) list `operations` in `in_progress|needs_repair` and let workers resume (journal is idempotent) — do not re-create records by hand;
  6) check `delivery_state` for `sending|ambiguous` rows from the gap and reconcile; 7) switch DNS; keep the old instance for rollback.
  Record the achieved RTO. Backup expiry (14 days) is documented client-side per SEC-04.
* After any restore, drafts older than 30 min are expired by the maintenance job and need no action.

## Tenant relocation (BRD §11) — procedure, **not yet exercised**
`tenant_id → deployment_id/twenty_workspace_id` is a registry (TEN-02) so user identities survive a move. Procedure: 1) freeze writes
(`UPDATE tenants SET status='suspended'`); 2) wait for the queue to drain (no `in_progress` operations); 3) migrate the Twenty workspace
(whole workspace + shared metadata/identity dependencies — *not* a bare schema copy) and media; 4) copy tenant-scoped rows (`WHERE tenant_id = …`) to the target
application DB; 5) reconcile counts and permissions; 6) update `twenty_workspace_id`/`twenty_base_url`/`deployment_id`; 7) reactivate; 8) keep the source until validated.
AT-15 requires demonstrating this in staging before using it as a production scaling option.

## Upgrades
Pin Twenty and all images. Promote through staging; run the permission/workflow regression (the e2e suite plus device checks). Never auto-upgrade Twenty in production.
Dependency updates: lockfile pinned; run `pnpm audit`, `pnpm test:all`.

## Retention (automated, SEC-04)
Drafts expire 30 min after the latest edit (minute job). Abandoned media 24 h; confirmed media 30 d (`media_objects.delete_after`); raw email 30 d; review items 30 d after resolution; processed webhook events payload dropped immediately and rows after 14 d; delivery state 30 d; audit 12 months (`app.audit_purge` switch is only set by the daily job). Operational logs: set a 30-day retention on the log sink (Cloud Logging bucket).
