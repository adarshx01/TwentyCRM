# Data model

App database only. Twenty objects are described in [the Recruitment Bricks CRM model](../01-crm-data-model.md) and are written through the REST client, not by sharing tables.

## Manifest (CFG-01–04)

Manifest `2026.1` is code in `apps/conversation/src/conversation/crm/manifest.py`.

- Stage ids are stable strings, not display labels (CFG-01).
- A tenant pins `manifest_version`. Drafts copy it (CFG-02).
- Allowed proposal fields are the Pydantic models in `crm/proposal.py`. Adding a Twenty field means a new manifest version, not a free-form key (CFG-03).
- The journal maps those fields onto Twenty REST shapes (`emails.primaryEmail`, `domainName`, `bodyV2.markdown`, task and note targets) (CFG-04).

“Lead” = Opportunity + Person + optional Company. A missing company skips that step. It does not invent a company.

## App tables

| Table | Purpose |
| --- | --- |
| `tenants` | Name, `deployment_id`, `twenty_workspace_id`, base URL, **API key reference**, manifest version, daily quota |
| `memberships` | Actor, role, `active` or `revoked` |
| `channel_bindings` | Channel + external id → membership. Unique per channel and external id |
| `enrollment_codes` | Hash of a one-time code, role, expiry, consumption |
| `drafts` | State machine, version, content hash, proposal JSON, expiry |
| `operations` | One journal per confirm idempotency key |
| `operation_steps` | `company`, `person`, `opportunity`, `note`, `task` with Twenty id and status |
| `outbox` | Messages waiting on a channel port (digests, future replies to staff) |
| `schedules` | Reminder digests |
| `intake_sources` | Opaque alias, `review` or `auto`, acting membership |
| `intake_messages` | Dedupe by tenant + message id |
| `inbound_events` | Webhook dedupe by channel + provider message id |
| `audit_events` | Actor, action, JSON detail. `tenant_id` may be NULL for unknown routes |

RLS is described in [tenancy](02-tenancy-and-roles.md). The SQL is `conversation.tenancy.rls.render_rls_sql()`, applied from Alembic revision `0001_initial`.

## Secret references

`twenty_api_key_ref` must start with `secret://` or `env://`. The admin API uses a schema that rejects extra fields, so a raw `twenty_api_key` cannot be posted. This build resolves `env://VAR` from the process environment and fails closed on `secret://` until a vault is configured. Values are not written to audit payloads.
