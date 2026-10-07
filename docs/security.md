# Security model

| Concern | Mechanism | Where / test |
|---|---|---|
| Tenant derivation (TEN-01) | Tenant/user only from verified channel bindings (WhatsApp sender + number ID, Teams Entra tenant + object ID) or the authenticated intake recipient/mailbox. Never from text, prompts, model output, URL, or token claims alone | `IdentityService`, `test/integration/identity-provisioning.spec.ts`, `test/e2e/prompt-injection.e2e.spec.ts` |
| Isolation (TEN-03) | Mandatory `tenant_id`, RLS (`FORCE`) with transaction-local `app.tenant_id`; non-superuser runtime role; tenant-prefixed object keys; per-workspace Twenty tokens via secret refs; cross-tenant IDs → 404 | `migrations/0002`, `DbService`, `tenant-isolation.spec.ts` |
| AuthN | Provider signatures (HMAC over raw body, constant-time), Microsoft JWT (issuer/audience/service URL), HS256 JWT with live membership re-check, operator API key (constant-time) | `webhook.spec.ts`, `security.spec.ts` |
| AuthZ | Role matrix + record scope enforced server-side on search, counts, summaries, linked records, notes, assignment, archive; re-checked at preview, at confirmation **and** at commit | `ActionAuthorizer`, `crm-operations.e2e.spec.ts`, `reports.spec.ts` |
| Prompt injection (SEC-02) | Content is delimited as untrusted; model-facing schema is strict and cannot express tenants/IDs/roles/tools/SQL; unknown fields are rejected (fail closed); executable actions are a separate strict union built by server code; targets resolved server-side from authorized candidates; only a human confirmation commits; minimal model context | `LlmIntentSchema`, `OpenAiProvider`, `security.spec.ts`, `prompt-injection.e2e.spec.ts` |
| Media (SEC-01) | Magic-byte type check, size/duration limits, optional ClamAV (fail closed), download only from allow-listed HTTPS hosts resolving to public IPs, redirects re-validated, size capped while streaming, never fetch URLs from cards/emails, private bucket + short-lived signed URLs | `media/`, `security.spec.ts`, `capture-edge-cases.e2e.spec.ts` |
| Email intake (§16–17) | Authenticated recipient routing, spam/injection heuristics, deterministic mapping, review for anything uncertain, dedup by provider event/Message-ID/submission ID/bounded fingerprint, no outbound to visitors, no URL fetch/attachments | `intake-flow.spec.ts` |
| Secrets | Env/file/GCP Secret Manager references only; manifests reject plaintext; logs redact tokens/secrets/text/transcripts/phones/emails | `secret-resolver.ts`, `logger.ts`, `manifest.ts` |
| Audit (SEC-03) | Append-only `audit_log` (DB trigger), masked payloads, correlation IDs from event → draft → CRM write → reply | `AuditService`, `tenant-isolation.spec.ts` |
| Retention (SEC-04) | Automated deletion jobs per policy | `MaintenanceService`, `maintenance.spec.ts` |
| Outbound recipients (SEC-05, WA-01) | Only active enrolled employees can be recipients; contact phone numbers from cards/forms are never looked up as recipients | `OutboundService` |
| Transport/storage | TLS at the LB, Cloud SQL `ENCRYPTED_ONLY`, bucket public-access prevention, container hardening (read-only FS, dropped caps) | `terraform/`, compose files |
| Supply chain | Lockfile; pinned image tags; minimal runtime image; run `pnpm audit` in CI | — |

**Known limitations** (see requirements audit): the native Twenty UI is a second route to records and needs Twenty-side row-level
permissions (G2); Twenty administrators have company-wide access by design and must be documented to clients; ClamAV scanning is optional until a daemon is configured; audit retention purge runs through a switch only the maintenance job sets.
