# API

Machine-readable: [`openapi.yaml`](openapi.yaml). Errors are `{ statusCode, code, message, timestamp, correlationId }`; send
`x-correlation-id` (8–64 chars) to propagate your own ID. Internal details never appear in responses.

## Authentication

| Surface | Mechanism |
|---|---|
| Employee API | `Authorization: Bearer <HS256 JWT>` with `userId`, `tenantId`, `exp`. The token only *names* a user: every request re-reads the live user, tenant and role (revocation applies immediately). The tenant is never taken from the body/URL. |
| Admin API | `x-api-key: <ADMIN_API_KEY>` (constant-time compare). Platform operators only; no customer CRM data is exposed. |
| WhatsApp webhook | `GET` verify token; `POST` `X-Hub-Signature-256` HMAC over the **raw** body |
| Teams webhook | Microsoft Bot Framework JWT (issuer, audience = app ID, service URL claim) |
| Twenty webhook | `X-Twenty-Webhook-Timestamp` + `X-Twenty-Webhook-Signature` = HMAC-SHA256(`<ts>:<body>`), ±5 min |
| Inbound email | `X-Signature: sha256=<HMAC of raw body>` with the per-provider secret (`EMAIL_WEBHOOK_SECRETS`) |
| Direct form events | `X-Signature` HMAC with the source's `webhookSecretRef` secret |
| `/metrics` | `Authorization: Bearer <METRICS_TOKEN>` or admin key |

## Employee endpoints

| Method & path | Notes |
|---|---|
| `GET /drafts/{id}` | State, `version`, 8-hex `hash`, expiry, operation id. Only the draft's owner. |
| `POST /drafts/{id}/confirm` | Header `Idempotency-Key` (8–200 chars) required. Body `{version, hash}` (strict). Returns `committing` + `operationId`/`reference`, `already_confirmed` for a repeat, `stale` if the preview changed, or `rejected`. Version/hash/actor/tenant must all match. |
| `POST /drafts/{id}/edit` | `{text}` using the chat edit grammar (`phone …`, `email …`, `note: …`, `stage …`). No CRM mutation until confirmation. |
| `POST /drafts/{id}/cancel` | Cancels an open draft; no CRM writes. |
| `GET /operations/{id}` | Scoped progress (`saved`, `pending`, `failed`) and safe error text. Own operations; CXO/admin see their workspace's. Other tenants → 404. |
| `GET /intake/review` | Manager+. Review queue (parsed fields only, no raw email). |
| `POST /intake/review/{id}/approve` | Manager+. Optional `corrections`. Idempotent: one operation (`intake:<id>`) however often it is called. |
| `POST /intake/review/{id}/reject` | Manager+. Creates no opportunity. |

## Webhook / intake endpoints

`GET|POST /webhooks/whatsapp`, `POST /webhooks/teams`, `POST /webhooks/twenty/{tenantSlug}`,
`POST /intake/email/{provider}` (202), `POST /intake/forms/{sourceId}` (202).

Inbound email envelope (after your provider verified SPF/DKIM/DMARC; put its verdict in `auth`):

```json
{ "eventId": "provider-event-id", "recipient": "k7f3q9x2@intake.example.com",
  "rawEmailBase64": "<RFC822 message>", "receivedAt": "2026-09-28T04:30:00Z", "auth": { "dmarc": "pass" } }
```
`recipient` must be the **actual delivery recipient from the authenticated provider event**; From/To/Reply-To headers are
never used for routing. Unknown or conflicting routes are quarantined.

Direct form event: `{ "submissionId": "S-1", "submittedAt": "…", "fields": { "Name": "…", "Email": "…", "Message": "…" } }`.

## Admin endpoints

`POST /admin/tenants[?dryRun=true]` (manifest, idempotent) · `GET /admin/tenants` · `GET /admin/tenants/{id}/users` ·
`POST /admin/tenants/{id}/users/{userId}/enrollment` · `…/revoke` · `PATCH …/users/{userId}` ·
`POST …/users/{userId}/token` · `POST /admin/tenants/{id}/reconcile` · `GET /admin/dead-letters` ·
`POST /admin/dead-letters/{id}/retry|resolve` · `GET /health/detailed`.

## Chat commands (employees)

`help` · `workspace` · card photo / voice note / text → draft · `Confirm` / `Edit` / `Cancel` (buttons or text) ·
`phone|email|name|title|company|website|interest|stage|amount <value>` · `note: …` · `task: … <date>` · `remove task` ·
`replace phone|email|title` · `continue without a note` · `new: <text>` (start a separate lead) ·
`Find …` · `Move … to <stage>` · `Follow up next Tuesday` · `Assign … to <name>` · `Archive …` / `Restore …` ·
`Who should I meet today?` · `Show my overdue follow-ups` · `Summarize <company>` · `Show my team's pipeline` ·
`What did we win this month?` · managers: `review`, `approve <id>`, `reject <id>` · `enroll BEE-XXXX-XXXX`.

## Event contracts

Normalized inbound event: `providerEventId, channel, connectionId, externalSenderId, conversationId, replyToId?, receivedAt,
messageType, text?, media[]?, interactiveResponse?` (`src/common/schemas/index.ts`). Tenant and user are added **after**
verification from the channel binding. Executable actions (`AllowedActionSchema`) are strict discriminated unions; the model-facing
schema (`LlmIntentSchema`) cannot express tenants, user IDs, record IDs, roles, tools or SQL.
