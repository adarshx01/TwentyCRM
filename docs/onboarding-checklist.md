# Client onboarding / offboarding checklist

## Before provisioning
- [ ] Twenty workspace created by the platform operator (controlled provisioning; public signup disabled). Note the workspace ID and sub-domain.
- [ ] Twenty API key created for the integration role (least privilege; **not** a person's key). Store in Secret Manager → `env:`/`gcp-sm:` reference.
- [ ] Twenty webhook (if used): URL `https://<host>/webhooks/twenty/<slug>`; secret stored → `webhookSecretRef`.
- [ ] Decide pipeline stage IDs/labels, required fields, timezone, working days, reminder time, currency, default country, teams, users and roles.
- [ ] Confirm retention overrides and AI data-handling terms with the client.
- [ ] Twenty: configure native row-level permissions (salesperson=own, manager=team, CXO=all), disable permanent destruction for ordinary users, restrict the Intake Review view to managers/admins. **Document native administrator powers to the client.**

## Provision
1. `node scripts/provision.mjs manifest.json --dry-run`, review, then without `--dry-run`. Re-running is safe.
2. Check the report: custom fields created, stage options, users created.

## Channels
- **WhatsApp**: the shared platform number needs the employee's number allow-listed by enrollment only. Approve the reminder template (`WHATSAPP_TEMPLATE_NAME`); confirm category/fees with Meta.
- **Teams**: build the app package (`TEAMS_APP_ID=… node scripts/build-teams-package.mjs`), upload to the client's Teams admin center, grant consent, install for users. Entra app registration: multi-tenant bot; messaging endpoint `https://<host>/webhooks/teams`.

## Enroll each employee
1. `POST /admin/tenants/:id/users/:userId/enrollment {"channel":"whatsapp"}` → one-time code (60 min, single use).
2. Deliver the code through an authenticated company process (never in a public channel).
3. Employee sends `BEE-XXXX-XXXX` from their own WhatsApp / Teams chat. Verify the binding appears.
4. Multi-client employees repeat per client and choose a workspace with `workspace`.

## Email intake (per form)
- [ ] Create the source in the manifest with a **random** alias (`k7f3q9x2@intake…`); add parsing rules from approved example emails; set mode `review` for the pilot, `auto` when stable.
- [ ] Client adds the alias as a recipient / forwarding rule (original notification preserved). Test the approved forwarding path; check DMARC evidence.
- [ ] Configure owner / round-robin, initial stage, source tag, optional follow-up and notification.
- [ ] Send a sample for each template; confirm AT-16..AT-21 behaviours.

## Offboarding
- [ ] Revoke users (`POST …/revoke`) — blocks commands, pending confirmations and reminders immediately.
- [ ] Set tenant `status` to `suspended`; export data per contract; revoke Twenty API key; delete secrets; run retention purge; keep audit per policy.


## Access onboarding (added with the access model — see `access-architecture.md`)

Order matters: **harden the workspace before inviting anyone** (a new Twenty workspace's default role can read, edit and
destroy everything).

1. **Workspace + keys** (operator): `scripts/twenty-bootstrap.mjs` (admin, workspace, integration key).
2. **Bee service user** (operator): `scripts/twenty-service-user.mjs`; store its password as a secret and put
   `twenty.serviceUser` in the manifest. Twenty only lets a *user* assign member roles and change workspace settings.
3. **Provision** (`POST /admin/tenants`): creates Bee's Twenty roles, sets the default role to *Bee · No access*,
   disables the public invite link and impersonation, downgrades the integration key to *Bee · Integration*, links the
   employees listed in the manifest, configures the CRM Bee app with this tenant's own secret.
4. **Install the CRM Bee app** into the workspace (`twenty apply` with an *admin* deploy key from
   `scripts/twenty-deploy-key.mjs`; the integration key cannot deploy apps by design), then re-run provisioning once so
   the app is configured.
5. **Employees** (client admin, inside Twenty › Bee › Users): *Add & invite* — Twenty e-mails a personal link; when
   it is accepted Bee links the account and assigns the role automatically. Salespeople and managers use Ask AI › Bee,
   WhatsApp and Teams; CXOs and client admins also get Twenty's own screens.
6. **Channels**: issue WhatsApp/Teams enrollment codes from the same page.
7. **Verify**: `scripts/verify/role-matrix.mjs` (and `isolation.mjs` for two clients).
