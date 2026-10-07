# Troubleshooting

| Symptom | Likely cause | Check / fix |
|---|---|---|
| App exits at start: `Configuration validation failed` | Missing/invalid env | The message lists each key; compare with `.env.example` |
| `permission denied for schema pgboss` / cannot create schema | Runtime role lacks `CREATE` on the database | `GRANT CREATE ON DATABASE crmbee TO crmbee_app` |
| Processes crash at start with `deadlock detected` | Old build without startup serialization | Fixed: queue start takes an advisory lock; upgrade |
| Everything returns no rows / `new row violates row-level security policy` | Connecting as the table owner without tenant context, or code path missing `tenantTx` | Runtime must use `crmbee_app`; all tenant data goes through `DbService.tenantTx/systemTx` |
| RLS appears not to apply | Connecting as a superuser | Use the non-superuser role (`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`) |
| WhatsApp webhook 401 | App secret mismatch, or a proxy re-serialized the body | Signature is over the raw bytes; do not transform the body |
| WhatsApp verification 403 | `WHATSAPP_VERIFY_TOKEN` differs | Set the same token in Meta |
| Teams 401 | Wrong `TEAMS_APP_ID`, clock skew, or endpoint behind an HTTP→HTTPS rewrite | The JWT audience must equal the app ID |
| Messages to an employee never arrive | Not enrolled / revoked / opted out / outside 24 h and template missing | `GET /admin/tenants/{id}/users` (bindings), `delivery_state.error_info` |
| Employee gets no reply | Unknown sender (by design: no reply) or revoked | Enroll; unknown senders never receive CRM data |
| Digest not sent | No salesperson role / non-working day / empty digest / no binding for the preferred channel | `schedules.error_info` (`empty`, `cutoff_exceeded`, `no_destination`, `recipient_ineligible`) |
| Digest late | Scheduler not running or Twenty budget | `overdueSchedules` in `/health/detailed`; `twenty_api_rate_limit_delays_total` |
| Captures slow | AI provider latency; per-tenant AI cap | `ai_extraction_duration_seconds`, `quotaLimits.maxAiJobsInFlight` |
| CRM write fails with 400 "Field … does not exist" | Custom fields not provisioned in the workspace | Re-run provisioning (idempotent) |
| `Several records match …` | Ambiguous target | Reply with the number; use `Find` first |
| Voice note rejected "looks corrupt" | Truncated container or no readable duration | Resend; supported: OGG/MP3/M4A/WAV/WebM ≤ 20 MB, ≤ 5 min |
| Intake email in review with "template not recognised" | Form changed | Update `templateMarkers`/aliases, bump `parserVersion` |
| Duplicate-looking enquiries rejected | Same submission ID / Message-ID, or identical content within 6 h | By design (IN-08); genuine repeats outside the window follow the repeat policy |
| Limiter errors in logs `redis unavailable` | Redis down | Service continues with a conservative local limit; restore Redis |
| Tests fail to start PostgreSQL | No server binaries | Install PostgreSQL 16 or set `PG_BIN`; or set `TEST_PG_ADMIN_URL` |
