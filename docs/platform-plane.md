# Platform plane: operators, companies, separated data (BRD §1, §4, TEN-05)

The BRD asks for **one shared Twenty in multi-workspace mode**, **one isolated workspace per client company**, and
**YlogX operators who provision and run companies without seeing their data**. This is how that is built and how to
test it by hand.

```
                         ┌──────────────── one Twenty server (IS_MULTIWORKSPACE_ENABLED) ───────────────┐
 YlogX operator ──►  ylogx.<domain>        acme-foods.<domain>        globex-retail.<domain>   …
                    "YlogX Platform"       company workspace          company workspace
                    Bee › Platform console  Bee › My Bee / Users …     Bee › My Bee / Users …
                          │                      ▲                          ▲
                          │ create company       │ client admin             │ client admin
                          ▼                      │ (own users, own data)    │
                    Bee platform API ────────────┴──────────────────────────┘
                    (named operators, audit, vault, support grants)
```

| Plane | Who | Where they sign in | What they can do |
|---|---|---|---|
| **Platform** | YlogX operators | `ylogx.<domain>` → **Bee** page (Platform console) | Create / suspend / reactivate companies, see people & health & usage, add operators, request support access. **No CRM records.** |
| **Company** | Client admin, CXO, manager, salesperson | `<company>.<domain>` → **Bee** page / Ask AI | Their own company only; roles per the capability matrix |

Operators cannot sign in to a company workspace (the provisioning account is removed from it after setup) and the
platform API exposes people, roles and health only. Reading a company's audit trail or acting as an employee needs a
**support grant** the company's own admin approved for a limited time.

## What the Platform console does

Bee page in the operations workspace → tabs:

* **Companies** – list with people, status, failed jobs, sync problems, pending support requests; open one for people,
  usage, pipeline, support grants; **Suspend / Reactivate / Re-sync access / Re-configure app / Update Bee app**.
* **New company** – name, address (becomes the sub-domain), client admin name + e-mail, time zone, currency, pipeline
  preset, teams. One click creates the workspace, installs Bee, applies the role model and hardening, stores the
  credentials in the encrypted vault and e-mails the first client admin. Runs in the background (~1 minute); the page
  shows progress; a failed step can be resumed and never creates a second workspace.
* **Operators** – add an operator (invited to the operations workspace with a console-only role), revoke.
* **Activity** – the platform audit trail (kept apart from every company's audit trail, append-only).

## Set-up (local)

```bash
# 1. a shared multi-workspace Twenty (127.0.0.1:3020, wildcard *.localhost works in browsers)
cd infra/twenty-m && cp .env.example .env   # or reuse the existing .env
docker compose up -d

# 2. platform settings in .env.local (generated once)
#    SECRETS_MASTER_KEY, PLATFORM_TWENTY_URL=http://app.localhost:3020,
#    PLATFORM_ADMIN_EMAIL=platform@ylogx.local, PLATFORM_ADMIN_PASSWORD

# 3. apply migrations, build, start Bee
set -a; . ./.env.local; set +a
DATABASE_URL="$MIGRATION_DATABASE_URL" node dist/database/migrate.js
./scripts/dev-up.sh

# 4. one-time bootstrap of the platform plane (operations workspace + app + first operator)
export PLATFORM_TWENTY_URL BEE_API=http://localhost:3400 BEE_APP_API_URL=http://host.docker.internal:3400
export TWENTY_INTERNAL_URL=http://server:3000
export TWENTY_DB_EXEC="docker exec crmbee-twenty-m-db-1 psql -U postgres -d default -c"
node scripts/platform-bootstrap.mjs      # prints PLATFORM_WORKSPACE_ID / PLATFORM_WORKSPACE_URL → add to .env.local, restart
```

Notes
* The bootstrap is idempotent. It cannot make the first server admin through an API, so the one-time `TWENTY_DB_EXEC`
  promotes the platform account (`canAccessFullAdminPanel`). After that, company creation needs nothing manual.
* Publish app changes with a **version bump** in `twenty-app/package.json` and `npx twenty app:publish --private`, then
  *Update Bee app* per company. **Never** `twenty apply` against a shared instance: it turns the registry entry into a
  workspace-local app and new companies can no longer install it.
* Local mail uses the LOGGER driver: invitation links are in the Twenty worker log
  (`docker logs crmbee-twenty-m-worker-1 | grep invite/`). On AWS they go out by SMTP.
* Docker Desktop's VM has ~5 GB: stop other Twenty stacks (`crmbee-twenty-b`) if the server restarts during installs.

## Manual test (≈15 minutes)

Accounts: operator **platform@ylogx.local** (password = `PLATFORM_ADMIN_PASSWORD` in `.env.local`). Company users you
create yourself. Use two browser profiles (or a private window) so sessions don't mix.

1. **Operator console.** Open `http://ylogx.localhost:3020`, sign in as the operator, skip Twenty's onboarding, open
   **Bee** in the sidebar → *YlogX Platform · Platform operator* with the Companies tab.
2. **Create company A.** *New company*: `Acme Foods`, client admin `priya@acme.example`. Watch the progress line;
   when it says *Company created* the invitation was sent.
3. **Create company B.** Same with `Globex Retail`, `rohan@globex.example`.
4. **Client admin joins.** Take Priya's invitation link from the worker log, open it, set a password. After sign-in the
   **Bee** page shows *Client admin* for **Acme Foods** (no manual linking). Add a salesperson under **Users**.
5. **Separated data.** In Acme's Twenty create a company record "Acme secret". Sign in to Globex as Rohan: the record
   is not there, the user list shows only Globex people.
6. **Salesperson.** Accept the salesperson's invitation: they can use Ask AI › Bee, but have no Users/Settings tabs and
   `/v1/tenant-admin/*` is refused.
7. **Operator limits.** In the console open Acme: you see people, roles, health and usage — not records. Try to sign
   the platform account in at `acme-foods.localhost:3020` → refused.
8. **Support access.** In Acme (console) *Request access* with a reason. As Priya open **Bee › Security & audit** →
   approve for 1 hour. Revoke it again; the operator loses access at once. Everything is in both audit trails.
9. **Suspend.** Suspend Acme: Priya and the salesperson are locked out, Globex is unaffected. Reactivate.
10. **Operators.** *Operators* tab → add a colleague; accept the invitation from the worker log; their console works
    on first sign-in. Revoke them.

Automated version of the above: `set -a; . ./.env.local; set +a; node scripts/verify/platform.mjs` (20 checks, ~3 min
the first time because it creates two companies).

## Limit: five workspaces without a Twenty Organization key

Twenty refuses to create more than **5 workspaces per server** unless the server has a valid Organization (enterprise)
key (`ENTERPRISE_KEY`). The operations workspace counts as one, so a free server holds **4 companies**. The console
reports this as "this Twenty server is at its limit". Options: obtain a Twenty Organization key, or run another
multi-workspace Twenty (a second `mserver` stack) and point a second platform plane at it. Bee does not work around the
licence check.

## AWS (deployed 2026-10-12)

| What | Address |
|---|---|
| Operations workspace (Platform console) | `https://ylogx.3-6-13-47.sslip.io` → **Bee** |
| Company workspaces | `https://<company>.3-6-13-47.sslip.io` |
| Existing single-workspace Twenty (company `aws-demo`) | `https://crm.3-6-13-47.sslip.io` (unchanged) |

A second Twenty (`mserver`/`mworker`/`mdb`/`mredis` in `deploy/aws/docker-compose.yml`, `IS_MULTIWORKSPACE_ENABLED`)
runs beside the original one. Caddy issues certificates **on demand** for company hosts and asks Bee first
(`/internal/tls-ask`, internal network only), so only names Bee serves get certificates. Invitations go out by SMTP.

* Secrets: `crmbee/env` in AWS Secrets Manager (`compose.env`: `M_*`; `bee.env`: `SECRETS_MASTER_KEY`, `PLATFORM_*`).
  The platform sign-in password is `PLATFORM_ADMIN_PASSWORD` there:
  `aws secretsmanager get-secret-value --secret-id crmbee/env --query SecretString --output text | jq -r '."bee.env"' | grep PLATFORM_ADMIN_PASSWORD`
* Bootstrap (done once, idempotent) from a workstation with AWS access:
  `AWS_INSTANCE=<id> PLATFORM_TWENTY_URL=https://app.<base> PLATFORM_ADMIN_EMAIL=… PLATFORM_ADMIN_PASSWORD=… CRM_CHAT_TOKEN=… PLATFORM_SUBDOMAIN=ylogx PLATFORM_REMOTE=aws-platform BEE_APP_API_URL=http://bee-api:3000 TWENTY_INTERNAL_URL=http://mserver:3000 node scripts/platform-bootstrap.mjs`
  then add the printed `PLATFORM_WORKSPACE_ID` to `bee.env` and release (this also closes the certificate window used
  during bootstrap).
* Twenty's `SERVER_URL` is the **base domain** (`https://3-6-13-47.sslip.io`); Twenty puts `app.` in front itself.
* Headroom: the instance (t3.large, 8 GB) runs both Twenty stacks plus Bee; consider t3.xlarge before adding many
  active companies.

## Code map

`src/platform/` (`company-provisioner.service.ts`, `workspace-factory.ts`, `platform.service.ts`,
`platform.controller.ts`, `platform-audit.service.ts`), `src/secrets/secret-vault.ts`,
`migrations/0005_platform_plane.sql`, `twenty-app/src/front-components/bee/platform.tsx`,
`scripts/platform-bootstrap.mjs`, `scripts/verify/platform.mjs`, `infra/twenty-m/`,
tests `test/integration/platform-plane.spec.ts`.
