# Tenancy and roles

## Tenancy (TEN-01, TEN-02)

One shared deployment. Turning on Twenty `IS_MULTIWORKSPACE_ENABLED` is a later change. This pass does not prove that flag on the pinned image.

`tenant_id` is an app-database key. It maps to:

- `deployment_id` — which Twenty installation
- `twenty_workspace_id` — which workspace inside that installation

**Tenant id never comes from the model or from message text.** Resolution order:

1. Verify the channel webhook (shared secret in this pass; per-tenant secret references later).
2. Deduplicate the provider message id.
3. Load the active `channel_bindings` row for `(channel, external_user_id)`.
4. That row’s `tenant_id` is the only tenant for the rest of the request.

A `tenant_id` field on a card, an email body, or a chat utterance is ignored. If the sender has no active binding, the event is unresolved and no CRM write happens.

Quotas are a stub: `tenants.daily_draft_quota`. `NULL` means unlimited. The check counts drafts created since UTC midnight and rejects the next create when the count is at the cap.

## Row-level security

Application queries are tenant-scoped. Postgres is a second line:

- The Alembic revision enables and **forces** row-level security.
- Policies compare `tenant_id` (or `tenants.id`) to the transaction GUC `app.tenant_id`.
- The app sets that GUC with `set_config('app.tenant_id', …, true)` on PostgreSQL connections only.
- Role `conversation_app` is `NOSUPERUSER NOBYPASSRLS`. Grants are in the migration.
- Superusers bypass RLS even when it is forced. The Docker `POSTGRES_USER` is a superuser and is for migrations only. The API DSN in `.env.example` uses `conversation_app`.

SQLite tests do not run this SQL. They still call the same tenant-scoped services. A unit test reads `render_rls_sql()` and checks that every tenant-owned table has a policy.

Unresolved audit rows may have `tenant_id` NULL. The strict policy does not return NULL rows to `conversation_app`. Operators inspect those with a migration role.

Binding, intake alias, and enrollment lookup happen **before** a tenant is known. Those three reads are `SECURITY DEFINER` functions in the migration (`resolve_channel_binding`, `resolve_intake_alias`, `resolve_enrollment_code`). They return one row and do not take a tenant id argument. The service then calls `set_config('app.tenant_id', …)` and continues with ordinary queries. Creating a tenant pre-assigns the id and sets the GUC to that id so the insert satisfies the policy. The GUC is chosen by the application after it has authenticated the actor. It is not read from message text. A stolen database password can set the GUC itself; RLS is not a substitute for keeping the DSN private.

## Roles at commit (IAM, ACT-03)

Chat filtering is not a substitute for Twenty’s own row-level permissions. **Gate G2 is unproven** until the pinned `twentycrm/twenty` edition is checked (including licence terms). The service still enforces its own roles again at commit:

| Role | Commit a draft | Revoke a membership |
| --- | --- | --- |
| `salesperson` | Only drafts they own | No |
| `manager` | Own drafts and drafts owned by a salesperson or manager in the same tenant | No |
| `cxo` | No | No |
| `client_admin` | No | Yes, inside their tenant |

A revoked membership fails commit even if the role would allow it (AT-14). Cross-tenant membership ids do not resolve.

## Enrollment

Client admins (or the operator API) issue an enrollment code. The database stores a hash. Redeeming the code creates a membership and a channel binding. Revocation flips the membership and its bindings to `revoked`.
