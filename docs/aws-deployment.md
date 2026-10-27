# AWS architecture and deployment — end to end

Region `ap-south-1`. Everything is created by `deploy/aws/provision.sh` (idempotent) and rolled out by
`deploy/aws/release.sh`. State of the created resources is kept in `deploy/aws/.state.json` (gitignored).

## 1. Resources

| Resource | Name / value | Purpose |
|---|---|---|
| Elastic IP | `3.6.13.47` | Stable address → stable HTTPS names |
| DNS | `*.3-6-13-47.sslip.io` (wildcard, no registrar needed) | `crm.`, `bee.`, `app.`, `ylogx.`, `<company>.` |
| Security group `crmbee-web` | inbound 80, 443 only | No SSH, no database ports |
| EC2 | `t3.large` (2 vCPU, 8 GB), Ubuntu 24.04, 60 GB gp3 encrypted, IMDSv2 required | Runs the whole stack |
| IAM role `crmbee-ec2` | `AmazonSSMManagedInstanceCore` + read releases bucket + read/put secret `crmbee/env` | Remote management without SSH |
| S3 `crmbee-releases-<account>-ap-south-1` | private, public access blocked, SSE-AES256 | Release bundles (`git archive`) |
| Secrets Manager `crmbee/env` | JSON: `compose.env`, `bee.env`, `agent.env` | All configuration and secrets |
| Supabase Postgres (external) | session pooler (migrations), transaction pooler (app) | Bee's data, row security enforced |
| Gmail SMTP (external) | smtp.gmail.com:465, app password | Twenty invitation mail |
| OpenAI (external) | API key in secret | Language model for the agent / Twenty AI |

## 2. Runtime topology (one host, Docker Compose project `crmbee`)

```
Internet ──80/443──► caddy ─┬─ crm.<base>          ─► server  (Twenty, single workspace "aws-demo") ─ db, redis, worker
                            ├─ bee.<base>          ─► bee-api (only /webhooks/* and /health)
                            └─ app./ylogx./<co>.<base> (on-demand TLS) ─► mserver (Twenty, multi-workspace) ─ mdb, mredis, mworker

bee-api · bee-worker · bee-scheduler  (same image, APP_ROLE=api|worker|scheduler) ─► bee-redis (AOF), Supabase, agent
agent (Python LangChain, internal only) ─► OpenAI
```

Containers (14): `caddy`, `db`, `redis`, `server`, `worker`, `mdb`, `mredis`, `mserver`, `mworker`, `bee-redis`, `agent`,
`bee-api`, `bee-worker`, `bee-scheduler`. Twenty is pinned to `v2.45.6`.

Networking rules
* Only Caddy publishes ports. Bee's admin API, chat relay, metrics, and `/internal/tls-ask` are reachable only on the
  Docker network. Operator/admin calls from a workstation go through SSM (`docker exec … bee-api`).
* Containers reach the public names through the host (hairpin to the Elastic IP works); Caddy also aliases `CRM_HOST`
  on the Docker network so Bee reaches the original Twenty without leaving the host.
* Twenty's `SERVER_URL` for the multi-workspace instance is the **base domain** (`https://3-6-13-47.sslip.io`); Twenty
  puts `app.` / `<workspace>.` in front.

## 3. TLS

* Named hosts (`crm.`, `bee.`) use automatic HTTPS (Let's Encrypt).
* Everything else uses Caddy **on-demand TLS**; before issuing, Caddy calls `bee-api:3000/internal/tls-ask?domain=…`.
  Bee approves only: the platform hosts, hosts of known tenants, and — while a company creation is running or before the
  platform workspace is configured — Twenty's generated address for the workspace being created.
* The Caddyfile is mounted from `/opt/crmbee/Caddyfile` (copied on each release, then `caddy reload`).

## 4. Configuration and secrets

`crmbee/env` → rendered by `apply.sh` into `/opt/crmbee/{compose,bee,agent}.env` (mode 0600, root).

| File | Notable keys |
|---|---|
| `compose.env` | `CRM_HOST`, `BEE_HOST`, `M_HOST` (base domain), `TWENTY_*` and `M_*` Postgres/app/encryption keys, `EMAIL_*`, `OPENAI_API_KEY` |
| `bee.env` | `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `JWT_SECRET`, `ADMIN_API_KEY`, `CRM_CHAT_TOKEN` (master of per-tenant app secrets), `SECRETS_MASTER_KEY` (vault), `PLATFORM_*`, `TWENTY_INTERNAL_URL=http://mserver:3000`, `CRM_APP_BEE_URL=http://bee-api:3000`, `AGENT_URL/TOKEN`, optional `WHATSAPP_*` |
| `agent.env` | `AGENT_TOKEN`, `OPENAI_*` |

Per-company credentials (Twenty API key, Bee's service-user password) are created by the Platform console and stored
encrypted in Bee's `secret_vault` table, referenced as `db:<name>` — they are not in the secret.

## 5. Provisioning (one time)

```bash
cd deploy/aws
AWS_REGION=ap-south-1 ./provision.sh      # EIP, secret (from .env.local), bucket, role, SG, EC2 (user-data installs Docker + apply.sh)
./release.sh                              # first rollout
```

`provision.sh` steps: Elastic IP → generate secrets (Supabase + OpenAI values come from `.env.local`) → release bucket →
instance role → security group → instance → associate EIP.

## 6. Release flow (every deploy)

1. `git archive HEAD` → `s3://…/releases/r<timestamp>-<sha>.tgz` (commit first: the bundle is `HEAD`).
2. SSM `send-command` runs `/opt/crmbee/apply.sh` on the instance:
   download → extract to `/opt/crmbee/current` → read `crmbee/env` → write env files → copy Caddyfile →
   `docker compose build` (Bee image built once) → **migrations** (`node dist/database/migrate.js` with the owner URL) →
   `docker compose up -d --remove-orphans` → `caddy reload` → prune images.
3. `release.sh` polls the SSM invocation and exits non-zero unless it succeeded; last log: `/opt/crmbee/last-release.log`.

Rollback: re-run `release.sh` from the previous commit (`git checkout <sha> && ./release.sh`). Migrations are
forward-only and additive, so older code keeps working against a newer schema.

## 7. Platform bootstrap (one time, after the first release)

Run from a workstation with AWS access (admin calls are executed on the instance through SSM):

```bash
AWS_INSTANCE=<id> PLATFORM_TWENTY_URL=https://app.<base> PLATFORM_ADMIN_EMAIL=platform@ylogx.local \
PLATFORM_ADMIN_PASSWORD=<from secret> CRM_CHAT_TOKEN=<from secret> PLATFORM_SUBDOMAIN=ylogx PLATFORM_REMOTE=aws-platform \
BEE_APP_API_URL=http://bee-api:3000 TWENTY_INTERNAL_URL=http://mserver:3000 node scripts/platform-bootstrap.mjs
```

It creates the platform account and operations workspace, promotes the account to server admin, creates the
console-only role, publishes and installs the CRM Bee app, creates the first operator and links it. Then put the
printed `PLATFORM_WORKSPACE_ID` into `bee.env` and release again (closes the bootstrap certificate window).

## 8. Day-2 operations

| Task | How |
|---|---|
| Create a company | Platform console → New company (≈1 min; invitation e-mailed) |
| Update the Bee app in Twenty | bump `twenty-app/package.json`, `npx twenty app:publish --private` (never `apply` on shared Twenty), then console → company → Update Bee app |
| Read the platform password | Secrets Manager `crmbee/env` → `bee.env` → `PLATFORM_ADMIN_PASSWORD` |
| Shell / logs | `aws ssm start-session` or `send-command`; `docker logs crmbee-bee-api-1` |
| Health | `https://bee.<base>/health`, `https://<host>/healthz`; `/health/ready` and `/metrics` are internal |
| Enable WhatsApp | add `WHATSAPP_*` to `bee.env`, release, register `https://bee.<base>/webhooks/whatsapp` in Meta |

## 9. Known limits (be honest)

* **Single host**: no HA; a host failure is an outage. Docker volumes (Twenty databases, files, Bee media, Caddy certs)
  live on one EBS volume and **are not backed up yet** — add EBS snapshots (AWS Backup) first.
* **Twenty licence**: max 5 workspaces per server without an Organization key (operations workspace counts).
* **Memory**: ~1.7 GB free on t3.large with both Twentys; move to t3.xlarge before adding many active companies.
* sslip.io names are fine for testing; use a real domain + ACM/Route 53 for production.
* A stale `local-demo` tenant row (from when local and AWS shared a DB) is still in the Bee database.

See `docs/architecture-overview.md` for the production hardening path.
