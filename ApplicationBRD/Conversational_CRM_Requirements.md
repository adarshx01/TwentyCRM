## Conversational CRM engineering requirements

Twenty CRM with WhatsApp and Microsoft Teams

YlogX | Version 1.1

Build an internal sales management service for multiple client companies. Twenty is the CRM system of record and web interface. Employees use WhatsApp and Microsoft Teams to capture leads, maintain sales records, receive morning reminders and request summaries. This specification defines the MVP, engineering boundaries and acceptance criteria.

## Confirmed scope

| Area | Requirement |
| --- | --- |
| Tenancy | One shared deployment initially; one isolated Twenty workspace per client. Initial capacity: 25 clients × 25 users = 625 registered users. |
| Channels | WhatsApp and Teams available in the product by default. Activate each client’s channel bindings during onboarding. Design adapters for future Slack and Telegram. |
| Users | Salespeople, managers, CXOs and client administrators. Internal stakeholders only; no automated lead or customer messaging. |
| Sales process | One activity line and one configurable pipeline per client. Configuration through Twenty administration and provisioning tools. |
| Capture | English text, cards and voice with confirmation; international contacts. Existing contact- form emails use validated automatic intake and review exceptions (sections 16–18). |
| Notifications | Morning reminders; business summaries on demand. Optional internal new-enquiry notifications for form intake; other sales alerts excluded. |
| Interface and hosting | Use Twenty’s web interface. Prefer GCP or OCI; no custom CRM dashboard. |

## Working defaults

The following are proposed implementation defaults, not additional confirmed business decisions: private chat for CRM commands; Teams channels for carefully scoped reminders; 09:00 local-time digests on configured working days; CRM tasks as the scheduling source; no Outlook calendar sync; recoverable archive instead of permanent chat deletion. Tenant configuration may override these defaults.

## How to use this document

MUST and SHALL identify acceptance requirements. Proposed sizing and service targets are engineering baselines to validate in the pilot. Resolve the feasibility gates on page 2 before committing to a fixed-price production build. Sections 16–18 add contact-form email intake to the MVP.


## 1 Feasibility and product decisions

## Twenty support and implementation boundary

Twenty documents shared-instance multi-workspace mode. Use IS_MULTIWORKSPACE_ENABLED=true, one workspace per client, wildcard DNS and TLS. Its metadata API supports schema configuration; record APIs support CRM operations. Pin a tested release and use its generated workspace API schema. Do not assume documentation for the moving main branch exactly matches the deployed release. [S1, S2]

Twenty documents row-level permissions for its Organization plan, including self-hosting. This matters because users also access the native web UI: filtering only in the chat middleware would leave another route to records. Establish the edition, licensed capabilities and commercial arrangement for serving multiple external clients. A single internal-use license must not be assumed to cover the service. [S3, S4, S5]

## Mandatory proof of capability

| Gate | Evidence required before production implementation |
| --- | --- |
| G1 Tenant isolation | Two workspaces with different pipelines; cross-workspace UI, API, search and attachment access denied. Verify first-signup restrictions and controlled provisioning. |
| G2 Permissions and licensing | Salesperson sees own records; manager sees team; CXO sees company, in UI and chat. Verify team rules, related records and service identity behavior. Obtain applicable hosted-service licensing terms. |
| G3 Pipeline configuration | Create different stage lists for two clients using supported metadata APIs or administration. Rename stages and demonstrate safe migration without changing other workspaces. |
| G4 Channel capabilities | Business card and audio capture on the target mobile clients; Teams private-chat file path; proactive private and channel delivery; WhatsApp reminder outside the reply window. |
| G5 Reliability | Repeated webhook and confirmation cause one business change. Recover a partially completed create operation without duplicate contact, deal or task. |

## Handling a failed gate

Document the exact gap and a costed remedy. Prefer supported configuration and correctly licensed features. If the required UI permissions cannot be enforced, do not release with middleware-only filtering. Changes to the agreed isolation model, Twenty UI availability or product scope require a product decision. Custom extensions must remain maintainable across upgrades.


## 2 Architecture and tenant isolation

Use a modular FastAPI application for the conversational service, with asynchronous workers. Separate channel transport, identity, authorization, intent extraction, CRM operations and scheduling. The LLM proposes structured actions; deterministic application code authorizes and executes them.

| Component | Responsibility |
| --- | --- |
| Twenty server and workers | CRM records, client-specific schema and native web UI. Use supported APIs; avoid direct database writes. |
| Channel adapters | Verify inbound events, fetch authorized media, normalize messages and deliver replies. Teams adapter may use a supported Microsoft SDK in a small sidecar. |
| Conversation service | Resolve tenant and user, maintain drafts, apply permissions, generate previews and manage confirmations. |
| Extraction service | OCR or vision for cards; speech-to-text for audio; structured extraction and source attribution. Providers selected through configuration. |
| CRM adapter | Workspace-scoped API access, field mappings, pagination, permitted queries, idempotent write orchestration and reconciliation. |
| Application PostgreSQL | Tenant registry, channel identities, drafts, operation journal, outbox, schedules, audit trail and delivery state. Separate from Twenty’s database ownership. |
| Queue and workers | Durable asynchronous processing, retries, scheduling and dead-letter handling. Redis-backed queue is acceptable with durable operation state in PostgreSQL. |
| Media storage | Private object storage with tenant separation and expiring authorized access. No publicly accessible card or voice-note URLs. |

## Tenancy requirements

- TEN-01 Employee actions derive tenant scope from verified channel bindings and membership. Form/email intake uses a registered source binding (section 16). Never trust tenant IDs in prompts, message bodies or model output.

- TEN-02 Map tenant_id to deployment_id and twenty_workspace_id. Keep one deployment initially; make this registry support later tenant migration without changing user identities.

- TEN-03 Tenant scope is mandatory in database rows, queue messages, caches, object keys, audit records and idempotency keys. Use application database row-level security as defense in depth and test connection- pool context reset.

- TEN-04 Isolate service credentials per workspace. Limit connection pools globally and per service. A workspace is a tenant boundary, not a dedicated compute allocation.

- TEN-05 Apply per-tenant quotas and fair scheduling so one client-s uploads or reminders cannot starve other clients. Disable public self-service tenant creation unless explicitly introduced later.


## 3 CRM data model and pipeline configuration

In the MVP, “lead” is the conversational name for a sales opportunity linked to a person and, when known, a company. It is not a second independent lead database. One contact may have several opportunities in the client’s single pipeline; creating another opportunity requires an explicit choice.

| Entity | Required application fields and rules |
| --- | --- |
| Person | Name, owner, team; optional email, phone, title and company. Preserve original spelling. Store international numbers in E.164 where enough country information exists; preserve the raw input too. |
| Company | Name, owner/team and optional website, domain, address and country. Do not merge companies by name alone. |
| Opportunity | Title, owner, team, stage and at least a contact or company. Optional amount, ISO currency, expected close date, interest, source and lost reason. No invented value or close date. |
| Activity or note | Related record, type, author, event time, text/transcript, channel, source message IDs and attachment references. Distinguish an observation from a future task. |
| Task or meeting | Related opportunity/contact, assignee, type, title, local due date or UTC timestamp with IANA timezone, duration/location if known, status and completion time. A meeting requires an explicit date and time. |
| Application metadata | External operation ID, source identity, created/updated timestamps, archive state and optimistic version. Map to native fields where available; provision custom fields only where required. |

## Configuration requirements

- CFG-01 Each client has ordered stage identifiers, labels, terminal won/lost classification, default initial stage, optional stage-required fields and a configuration version. Example only: New → Qualified → Meeting → Proposal → Negotiation → Won or Lost.

- CFG-02 Provision using a versioned manifest and supported metadata APIs. Where API coverage is absent, document the exact Twenty administrator steps. Re-running provisioning must not duplicate schema or roles.

- CFG-03 Configure timezone, working days, morning reminder time, default currency, teams, user mappings, notification destination, channel credentials and retention policy. Store secret references rather than secret values in manifests.

- CFG-04 Keep stable stage IDs when labels change. A stage with active records cannot be removed without a previewed migration to another stage. Validate chat actions against the current configuration.

The engineer must deliver the actual native-object and field mapping from the pinned Twenty release, including task relationships and archive behavior. Use a small custom Meeting object only if native tasks cannot represent the required fields cleanly.


## 4 Identity roles and access

| Role | Record scope | Allowed actions |
| --- | --- | --- |
| Salesperson | Owned or assigned records | Create, read and update within scope; add notes; complete/reschedule own tasks; request archive. |
| Manager | Own records and assigned teams | Salesperson actions plus team assignment, team summaries and archive/restore within scope. |
| CXO | All records in the client | Create, read and update records; company summaries, assignment and archive/restore. No cross-client access. |
| Client admin | Own workspace | Manage users, teams and configuration; archive/restore. Treat native administrator access as privileged company-wide access. |
| Platform operator | Service administration | Provision and operate tenants. Customer-data access only through explicitly authorized, audited support access. |

Archive approval is restricted to manager, CXO or client admin by default. No permanent delete command in chat. Disable permanent destruction for ordinary users in Twenty. Native administrator powers must be documented rather than represented as more restricted than they are.

## Identity binding

- IAM-01 Administrator provisions each employee and binds their Twenty membership to a verified WhatsApp identity and/or Microsoft Entra tenant ID plus object ID. Phone ownership alone does not grant access to a client.

- IAM-02 Use an expiring, single-use enrollment link/code delivered through an authenticated company process. Record who approved enrollment; reject unknown senders without disclosing CRM information.

- IAM-03 Teams tenant, conversation and channel must match the approved client mapping. For a shared WhatsApp service number, use the allowlisted sender membership to determine the client. Never route by a typed company name.

- IAM-04 If a person has multiple client memberships, require explicit workspace selection from their authorized memberships; keep sessions separate. Bind every draft to tenant, actor and conversation.

- IAM-05 Revocation or role change must block subsequent commands, pending confirmations and outbound reminders within five minutes. Reassignment updates access and task ownership consistently.

## Enforcement across every path

Apply the same scope to search, counts, summaries, cards, media, CRM links, exports and linked records. Inaccessible duplicate matches return no identifying details. Recheck authorization when reading and again when committing a draft. A service API key represents the integration, not automatically the employee; explicitly enforce employee scope in middleware and verify native UI permissions separately.

Resolve shared company/contact access deliberately: either include an explicit authorized team set or restrict the parent record. A relation must not expose another salesperson’s notes, tasks or opportunities. Do not use prompt instructions as an access-control mechanism.


## 5 Business card and voice capture journey

## The user experience

A salesperson uploads a card and says: “Met Rajesh from ABC Industries. Interested in demand forecasting. Meet him on 29 September at 11 AM.” The assistant extracts contact information, proposes an opportunity and meeting, then shows one combined preview. The user corrects the phone number and confirms. Only then are the records saved.

## Required behavior

- CAP-01 Accept JPEG/PNG cards and supported audio attachments. Proposed limits: 10 MB per image and five minutes or 20 MB per audio file, subject to channel limits. Validate actual file type and reject corrupt or unsupported files with a useful message.

- CAP-02 Start a capture draft when the first card/text/audio arrives. Prompt for context or -continue without a note.” Link replies to the draft/message ID. If several drafts are possible, ask which one; never silently attach a note to the last lead.

- CAP-03 Extract name, business name, title, phone numbers, email, website and address where present. Extract interest, meeting notes and next action from text or transcription. Record the source of each proposed field. Missing values remain blank.

- CAP-04 Present uncertain or conflicting fields for correction. Never infer a country code solely from a company name or silently replace card details with voice details. A short name plus an owner is sufficient for a contact; clarify the record target if both person and company are absent.

- CAP-05 Resolve relative dates against the sender-s timezone and message timestamp; display an absolute date and timezone in the preview. Ask for ambiguous dates, missing meeting times or unclear people. Date- only follow-ups are allowed; they are not calendar appointments.

- CAP-06 Search within permitted tenant records using normalized email and phone; use name plus company as a possible match. Present “update existing” or “create new” where appropriate. Never merge automatically or overwrite a populated field without displaying the change.

- CAP-07 Show person/company, opportunity title and stage, owner, notes and proposed tasks together. Provide Confirm, Edit and Cancel through buttons or unambiguous text commands. State that the draft has not yet been saved.

- CAP-08 On success return a stable reference and authorized Twenty link. If part of the operation is pending, state exactly what was saved and what is retrying. Never announce complete success before all confirmed actions finish.

## Extraction quality

Before pilot sign-off, evaluate at least 100 representative English business cards and 50 English voice notes including Indian accents, international contacts and background noise. Proposed target: at least 95% exact normalized extraction of legible email/phone fields. Report performance by field, correction rate and abstentions; uncertain transcription must never bypass confirmation.


## 6 Record operations and confirmation

| Command example | Expected result |
| --- | --- |
| “Find Rajesh at ABC” | Search only allowed records, show concise matches and ask which record if ambiguous. |
| “Move this lead to Proposal” | Validate the stage and required fields; preview the change; save after confirmation. |
| “Met Rajesh today; proposal requested” | Draft a dated activity note. A task is proposed only if explicitly stated or requested through clarification. |
| “Follow up next Tuesday” | Propose a linked task with the resolved date; include it in the confirmation. |
| “Move tomorrow’s meeting to Friday at 3” | Resolve the meeting and date, preview old and new time; replace the existing schedule after confirmation. |
| “Assign this to Meera” | Check assignment permission and active same-client membership; preview ownership and affected task changes. |
| “Delete this lead” | Explain recoverable archive; ask an authorized role to confirm. Archived records leave active searches and reminders. |
| “Restore this opportunity” | Authorized restore after preview. Do not revive old reminder deliveries or silently change completed tasks. |

## Confirmation contract

- ACT-01 All chat-driven creates, updates, task changes and archive/restore operations require a preview and explicit confirmation. Read-only queries do not. Twenty web edits follow native UI behavior; they still drive reminder reconciliation.

- ACT-02 Give each proposal a draft ID, version and content hash. Proposed expiry: 30 minutes after the latest edit. A confirmation is valid only for that actor, tenant, version and conversation. Corrections invalidate older buttons and previews.

- ACT-03 Serialize commits for the same draft. If the target record or relevant configuration changed after preview, re-read it and ask for confirmation of a fresh preview. Check current permissions again.

- ACT-04 State sequence: collecting  awaiting confirmation  committing  committed, cancelled, expired or needs repair. Store source event IDs and a stable operation ID durably.

- ACT-05 Treat delivery as at least once. Deduplicate provider events, confirmation clicks and outbound sends. A worker restart or timeout must not create a second business operation.

## Multi-record writes

Do not assume Twenty offers one transaction across person, company, opportunity, note and task. Use an operation journal with step-level identifiers and reconciliation after timeouts. Resume only missing steps. Keep partial records auditable; never roll back by deleting a pre-existing record. Expired or cancelled drafts create no CRM records.


## 7 WhatsApp and Teams integration

## WhatsApp options and recommendation

Open-source choices exist. Baileys connects through WhatsApp Web and identifies itself as unofficial. Evolution API provides a self-hosted integration layer with both a Baileys connection and an official Cloud API connection. Its repository includes additional licensing conditions; review the selected version before adoption. [S6, S7]

Recommended production baseline: Meta Cloud API directly, without a mandatory Gupshup subscription. A self- hosted wrapper does not remove Meta’s rules or charges when using the official connection. Keep unofficial Web-based connectivity as an optional evaluation adapter, not a production dependency without an explicit reliability and account-risk decision.

- WA-01 Only onboarded employee recipients are allowed. Customer phone numbers extracted from cards must never become outbound recipients. Suggested starting topology: one platform service number, with strict allowlisting; allow dedicated client numbers without changing business logic.

- WA-02 The official API permits ordinary replies inside the 24-hour customer-service window after an employee message; outside it, a template is required. Morning reminders must support approved templates and recipient opt-in even though recipients are employees. Template approval/category and actual fees are external dependencies, not guaranteed in this specification. [S8, S9]

- WA-03 Use a minimal template such as a reminder that the daily task list is ready, subject to approval, then return details after the employee replies. Send a detailed digest directly when allowed. Track sent/delivered/failed status separately and never promise that acceptance equals delivery.

## Teams requirements

- TM-01 Deliver an installable Teams app with private bot chat and channel messaging. Document Entra registration, required consent and tenant installation. The application services may run on GCP/OCI; Microsoft registration remains required.

- TM-02 Retain conversation references for proactive messages and handle uninstall/reinstall. Teams requires app access/installation for the destination. Use a currently supported Microsoft SDK and verify its authentication model for multiple customer tenants. [S10]

- TM-03 Use private chat for card/audio capture in MVP. Teams file APIs differ by scope; Graph may be needed for channel files. Test native mobile voice-note retrieval before claiming support; guarantee a supported audio-file upload route and disclose any native voice-note limitation. [S11]

- TM-04 Use Adaptive Cards for previews where supported. A channel is a shared audience: detailed reminders are permitted only when every viewer is authorized. Otherwise post a generic notice linking users to private chat. Handle bot mentions explicitly; do not ingest unrelated channel discussions.


## 8 Morning reminders and summaries

## Reminder rules

- REM-01 On each configured working day, generate one digest per active salesperson at the user-s local start-of-day time. Tenant defaults apply if user preferences are absent. Store IANA timezone and calculate UTC execution safely through daylight-saving changes.

- REM-02 Use CRM meetings and open tasks: today s meetings in time order, due-today follow-ups, overdue open tasks in a separate section. Include contact/company, next action, due time and an authorized CRM reference. Date-only tasks must not display an invented meeting time.

- REM-03 Schedule automatically when the confirmed task is created or edited. No second scheduling action is required. New leads without a next action prompt for one during capture; do not invent a due date or create a reminder from a vague expression of interest.

- REM-04 Choose one preferred delivery destination per employee; both channels remain available for interaction. Optional dual delivery must be explicitly configured. A Teams channel destination is subject to the audience rule on page 8.

- REM-05 Proposed defaults: Monday-Friday, 09:00, skip an empty digest, no separate pre-meeting alerts, no repeated intraday overdue alerts and no manager escalation. All scheduling settings are configurable without a code change.

- REM-06 Before dispatch, re-read task state and recipient eligibility. Exclude completed, cancelled and archived items. Use a unique key of tenant/user/local-date/digest-type. Consolidate a channel’s authorized reminders into one message where appropriate.

- REM-07 Retry transient delivery failures with capped exponential backoff and jitter. Stop after a configurable morning cutoff, default two hours; record the failure for operations. Do not silently switch destinations or send obsolete digests the next day.

## On-demand reporting

SUM-01 Support “Who should I meet today?”, “Show my overdue follow-ups”, “Summarize ABC Industries”, “Show my team’s pipeline” and “What did we win this month?”. Salesperson scope is personal, manager scope is team, and CXO scope is the client. No automatic daily/weekly business reports in MVP.

SUM-02 Compute counts and totals deterministically from authorized CRM queries; the LLM may narrate results. Include the reporting period, timezone, record scope and retrieval time. Show stage counts, opportunity values, next actions and relevant recent notes. Group values by currency; never add INR and USD or invent exchange rates.

SUM-03 Define open pipeline as non-archived, nonterminal opportunities. Won/lost reporting uses the recorded stage-change date, not last-modified time. Paginate all matching records before aggregate calculations; disclose truncation or unavailable history. Return “no matching records” instead of fabricating an explanation.


## 9 Service contracts and synchronization

## Normalized message and action contract

Each inbound event carries provider_event_id, channel, connection_id, external_sender_id, conversation_id, reply_to_id, received_at and media descriptors. After verification, the service adds resolved tenant_id, user_id and authorization context. Provider and model supplied tenant claims are never authoritative.

Each proposed action carries operation_id, draft_id, draft_version, action_type, target IDs, field changes, expected record version, source references and proposed task changes. Validate against typed schemas and an allowlist of operations; unknown fields and arbitrary code/SQL are rejected.

| Internal interface | Contract |
| --- | --- |
| POST /webhooks/whatsapp | Verify authenticity, persist/deduplicate event, acknowledge promptly, enqueue processing. Handle delivery receipts separately. |
| POST /webhooks/teams | Validate Microsoft activity authentication and tenant mapping; normalize messages and card actions. |
| POST /drafts/{id}/confirm | Authenticated actor; version/hash and idempotency key required. Return committed result or durable operation status. |
| POST /drafts/{id}/edit or /cancel | Authorize actor, modify/version preview or cancel. No CRM mutation until confirmation. |
| GET /operations/{id} | Return scoped progress and safe failure information; never expose another tenant’s operation. |
| POST /admin/tenants and configuration | Restricted provisioning/configuration service or CLI. Versioned manifest, audit trail and secret references; no public signup API required. |

## Twenty synchronization

- SYNC-01 Twenty is authoritative for contacts, opportunities, notes and tasks. Keep only operational state and necessary indexes in the application database. No independent editable copy of the sales pipeline.

- SYNC-02 Use available Twenty change events for task/owner/stage changes; verify event authenticity where supported and always re-fetch the record in its workspace. Add periodic reconciliation, proposed every five minutes, to recover missed events and native web edits.

- SYNC-03 Maintain stage history and won/lost transition timestamps for reporting. Do not claim historical transition metrics for imported records without that history.

- SYNC-04 Use pagination, per-workspace rate budgets and Retry-After handling. Twenty documents an API rate limit and batch constraints; verify their scope and configurability in the selected release before setting worker concurrency. [S2]

Log correlation IDs from channel event to draft, CRM write and outbound reply. Display concise recoverable errors to employees; detailed provider and database errors belong in restricted operational logs.


## 10 Deployment capacity and service targets

Deploy first to one selected cloud, GCP or OCI, using portable containers and infrastructure as code. A shared deployment may contain multiple application replicas; it does not require putting all services on one VM. Final machine sizes and monthly cost need measured pilot load and the selected region.

## Proposed starting infrastructure

| Layer | Baseline to benchmark |
| --- | --- |
| Application compute | Two application nodes, each 4 vCPU and 16 GB RAM, distributing Twenty, API and worker containers. Use a load balancer and avoid single-host dependence for production. |
| Database | Managed PostgreSQL where compatible: start at 4 vCPU, 16 GB RAM and 100 GB expandable storage. Separate databases/roles for Twenty and application state. Verify required versions and extensions. |
| Queue and media | Redis-compatible queue capacity based on load tests, initially 2–4 GB; durable journals in PostgreSQL. Private object storage with lifecycle policies. |
| Provider mapping | GCP: Compute Engine, Cloud SQL, Secret Manager and object storage. OCI: Compute, compatible PostgreSQL service, Vault and Object Storage. Validate regional availability and Twenty storage- driver compatibility. |
| Portability | Twenty currently documents S3-compatible production storage. Do not assume native GCS or OCI APIs are drop-in equivalents; test credentials, signing, upload, download and CORS or deploy a supported storage layer. [S1] |

## Load test envelope

Proposed engineering test: 25 tenants, 625 users, 100 simultaneous active chat sessions, 250,000 total opportunities and 1,000,000 total activities/tasks. Sustain five inbound events/second for 30 minutes and a 20- event/second burst for 60 seconds. Exercise a synchronized morning batch for all 625 users alongside ordinary traffic. These are test assumptions, not observed production demand.

| Measure | Proposed acceptance target |
| --- | --- |
| Webhook receipt | p95 under 2 seconds to durable acceptance, excluding provider network latency. |
| Interactive response | p95 under 10 seconds for simple read/text operations; under 30 seconds for a card or a voice note up to 60 seconds. Longer jobs show progress. |
| Reminder dispatch | 99% submitted to the provider within 10 minutes of scheduled time under agreed load. Measure actual delivery separately. |
| Availability and recovery | 99.5% monthly service target; recovery point ≤15 minutes and recovery time ≤4 hours, demonstrated with database and media restoration. |


## 11 Security operations and growth

## Security and data handling

- SEC-01 Enforce TLS, encrypted databases/storage and secret-manager credentials. Validate webhook signatures/tokens, media source hosts, file size and type. Block arbitrary URL fetching and scan uploads. Never log tokens or full raw media.

- SEC-02 Treat cards, transcripts and notes as untrusted content. Embedded instructions cannot alter permissions, select tenants, invoke arbitrary tools or authorize a save. Use minimal CRM context for model calls and select providers under client-approved data handling terms.

- SEC-03 Audit actor, tenant, channel, source event, action, changed fields, confirmation, timestamp and result. Mask sensitive payloads in routine logs. Protect the operation journal and audit trail from ordinary user editing.

- SEC-04 Proposed retention: expire unconfirmed drafts after 30 minutes; remove abandoned media within 24 hours; retain source media for 30 days after confirmation, transcripts as CRM notes, operational logs for 30 days and audits for 12 months. Client policy may override; implement automated deletion and documented backup expiry.

- SEC-05 Disable outbound customer messaging and general mailbox/calendar sync. Section 16 permits scoped form-email intake. Assistant recipients must be active employees or approved internal Teams destinations, never CRM contacts.

## Operational readiness

Provide health checks, dashboards and alerts for queue age, failures, duplicate suppression, webhook authentication errors, token expiry, disconnected channel sessions, database connections, backup status and reminder delivery. Track usage/cost by tenant: model tokens, transcription minutes, media storage and channel messages. Technical alerts go to operators, not as unsolicited sales reports.

Back up CRM, operational state, media and required configuration/keys. Test recovery to a separate environment and reconcile incomplete operations. Apply pinned releases through staging, run permission and workflow regressions, and document database migration rollback or restoration procedures. Do not auto- upgrade Twenty in production.

## Scaling and tenant relocation

Start capacity review at 25 clients or 625 users. Proposed earlier triggers: database connections or CPU above 70% for 15 minutes, p95 latency above target, oldest interactive job above 60 seconds, repeated morning dispatch misses, or one client consuming over 25% of capacity. These trigger investigation, not automatic migration.

First tune queries, API budgets, connection pools and worker concurrency, then scale shared services. Partition by moving whole workspaces to another deployment only when supported by a tested migration procedure. Freeze the tenant’s writes, migrate related data/media/configuration, reconcile counts and permissions, switch tenant routing, validate and retain a rollback path. Do not assume copying one PostgreSQL schema is sufficient; Twenty may also have shared metadata and identity dependencies.


## 12 Acceptance scenarios

Execute these tests on the pinned release and both configured channels. Automated tests must cover authorization, repeat delivery, time calculations and failure recovery; use real-device checks for media and Teams/WhatsApp behavior.

| ID | Scenario and passing condition |
| --- | --- |
| AT-01 | Create client A and B with different stages. A’s users cannot read B through UI, API, search, guessed IDs, media URLs, summaries or stale channel bindings. No cross-tenant side effects. |
| AT-02 | A salesperson cannot read another owner’s records. Manager sees only assigned teams; CXO sees client-wide data. Test related contacts, notes, task counts, exports and service API routes. |
| AT-03 | Card plus voice note produces one preview containing extracted details, interest and explicit meeting. Correct a field and confirm; one person, opportunity, note and task appear with proper relations. |
| AT-04 | Cancel, timeout, replay an old button, or confirm as another user. No unauthorized CRM writes occur. Repeated valid confirmation returns the same result. |
| AT-05 | Upload the same card twice and match an existing email/phone. Assistant offers permitted existing records; populated fields are not overwritten silently. |
| AT-06 | Create, search, update stage, add note, reassign, reschedule, archive and restore. Each mutation respects scope and confirmation; invalid stages fail clearly. |
| AT-07 | Use ambiguous dates, country codes and noisy audio. Assistant asks for clarification or marks uncertainty; no invented meeting, amount or contact detail is saved. |
| AT-08 | Tasks created or edited in Twenty appear in the next digest. Completed/archived/reassigned tasks are removed correctly. Test local midnight, DST and nonworking days. |
| AT-09 | Morning job runs twice or restarts halfway through. Each intended digest is dispatched once where provider semantics permit; ambiguous sends are reconciled, not blindly retried. |
| AT-10 | WhatsApp template is required outside the reply window. Test approved template, rejection, opted-out user and blocked delivery; no ordinary out-of-window send is attempted. |
| AT-11 | Teams private card/audio upload and proactive delivery work on target devices. Unauthorized channel audiences receive no sensitive content. Uninstalled app is handled cleanly. |
| AT-12 | Pipeline and won-this-month totals match a known fixture across pagination and currencies. No unauthorized or archived data, fabricated narrative or scheduled business report. |
| AT-13 | Twenty times out after a successful create; worker restarts mid-operation. Reconciliation completes missing steps without duplicate records and reports partial failure accurately. |
| AT-14 | Revoke a user while a draft/reminder is pending. Access and delivery stop within five minutes. Prompt injection in an image or transcript cannot override this. |
| AT-15 | Meet the load envelope and service targets; restore a backup within recovery targets. Demonstrate tenant relocation in staging before using it as a production scaling option. |


## 13 Delivery plan and engineer handoff

## Milestones and exit criteria

| Stage | Required outcome |
| --- | --- |
| 1 Feasibility | Pass G1–G5; record Twenty version and feature/license position, WhatsApp choice, Teams SDK/authentication/media behavior and measured prototype results. |
| 2 Tenant foundation | Reproducible cloud deployment, controlled workspace provisioning, configurable pipeline, identity binding, role enforcement and operational database. |
| 3 Conversational CRM | Both chat adapters, card/audio capture, confirmation, CRUD/archive and recovery. Add configured form-email intake and internal review (sections 16–18). |
| 4 Reminders and reports | Timezone-aware morning digests, native Twenty change reconciliation, on-demand scoped summaries, delivery statuses and cost telemetry. |
| 5 Pilot and release | Pilot with two clients and representative users; complete acceptance suite, load/security tests, restore drill, administrator training and support runbooks. Expand to 25 clients after review. |

## Required deliverables

- Versioned source repositories, container definitions, infrastructure-as-code, deployment instructions, environment variable reference and an inventory of third-party dependencies/licenses.

- Tenant provisioning manifest and repeatable scripts; native Twenty object/field mappings; pipeline templates; roles and team configuration; client onboarding/offboarding checklist.

- OpenAPI specification and channel event mappings; structured action schemas; operation state machine; database migrations; provider setup guides and Teams app package.

- Automated tests with fixtures and results; supported device/media matrix; extraction evaluation; load report; backup/restore and tenant migration runbooks; monthly cost model by usage component.

## Decisions to close during feasibility

Select GCP or OCI and region; confirm the Twenty commercial arrangement for multi-client hosting and row- level permissions; choose the WhatsApp production adapter and service-number topology; confirm reminder template eligibility; establish the Teams registration/consent approach; approve retention defaults and any provider data-processing terms. These decisions may change cost and effort, but do not prevent prototyping the defined workflows.

## Explicitly outside version one

Customer outreach, WhatsApp campaigns, customer chat ingestion, call recording, autonomous sales decisions, lead enrichment, forecast scoring, manager escalation, scheduled business reports, Outlook calendar synchronization, multiple pipelines per client, custom CRM dashboard, Slack/Telegram implementation and live meeting transcription. Keep extension points for these without building them now.


## 14 Source references

Technical documentation reviewed on 26 September 2026. Validate all referenced capabilities against the chosen release. Links establish upstream capabilities and constraints; the requirements, sizing and architecture in this document are the proposed implementation design.

## S1 Twenty self hosting setup

Shared-instance multi-workspace setup and storage configuration.

https://docs.twenty.com/developers/self-host/capabilities/setup

## S2 Twenty APIs

Workspace-generated core and metadata APIs; API authentication and published request limits.

https://docs.twenty.com/developers/extend/api

## S3 Twenty permissions

Object, field and row-level permissions; row-level feature availability for self-hosting.

https://docs.twenty.com/user-guide/permissions-access/capabilities/permissions

## S4 Twenty terms

Distinction between open-source self-hosting and commercially licensed features; internal-use scope of standard license keys.

https://twenty.com/terms

## S5 Twenty repository license

AGPL, package exceptions and commercially marked files. Confirm the selected version and applicable service agreement.

https://github.com/twentyhq/twenty/blob/main/LICENSE

## S6 Baileys quickstart

Unofficial WhatsApp Web library and connection model.

https://github.com/WhiskeySockets/docs/blob/main/quickstart.mdx

## S7 Evolution API repository

WhatsApp Web and Cloud API integration options and repository licensing conditions.

https://github.com/evolution-foundation/evolution-api


## 15 Channel references and configuration example

## S8 Meta message rules and getting started

Customer-service window and template requirement. Recheck current rules and reminder template eligibility during G4.

https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages

## S9 Meta pricing

Template delivery charges and current pricing. No fixed provider price is assumed in this document.

https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing

## S10 Microsoft Teams proactive messaging

App installation/access and conversation references for proactive messages.

https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive- messages

## S11 Microsoft Teams file handling

File handling differs between private chat and channel/group scopes.

https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4

## Example client configuration

Illustrative values for the provisioning manifest; this is not a customer record.

| Setting | Example |
| --- | --- |
| Client and routing | tenant_id: client_001; deployment_id: shared_01; workspace ID assigned during provisioning |
| Business settings | One consulting pipeline; currency INR; timezone Asia/Kolkata; Monday–Friday; morning time 09:00 |
| Channels | WhatsApp enabled and Teams enabled after onboarding; preferred reminder destination set per user |
| Pipeline | new, qualified, meeting, proposal, negotiation, won, lost; terminal outcome attached to won/lost |
| User and identity | Internal user ID mapped to Twenty member, team, role, verified WhatsApp identity and Entra tenant/object IDs |
| Secrets and versions | Secret-manager references only; schema/configuration version recorded; no provider credentials in the manifest |


## 16 Contact form email intake

Version 1.1 adds website enquiries to the MVP. Clients normally retain their existing Contact us forms and the emails those forms already generate. The product receives those notification emails and creates CRM enquiries. This is inbound lead capture; it does not authorize customer messaging or unrestricted mailbox synchronization.

## Intake routes

- IN-01 Primary route: provision an opaque, unique intake email address per client/form. The client configures a mailbox forwarding rule for form notifications, or adds the address as a recipient in the existing form settings. Preserve the original notification for the client; no website redesign is required.

- IN-02 Alternative: connect an approved mailbox or dedicated folder with minimum required read access, using a supported provider API or secure IMAP adapter. Select and prove the pilot provider during feasibility. Document OAuth/consent, shared-mailbox support, incremental sync and reconnect behavior. Do not require a generic connector for every mail provider in MVP.

- IN-03 Optional direct route: a website server sends a signed form event to POST /intake/forms/{source_id}. Build this after email intake if needed. Keep Twenty credentials server-side. Both routes normalize into the same intake service and obey the same rules.

## Tenant routing and trust

Resolve tenant and source from the authenticated inbound-email provider event and actual delivery recipient, or the registered mailbox connection/folder. A unique alias identifies a route, not an authenticated prospect. Never route by the company name, visible To/From text, Reply-To address or a tenant ID embedded in the message. Quarantine unknown or conflicting routes.

Validate provider signatures and apply sender/template rules, rate limits and spam checks. Sender allowlists alone are insufficient: forwarded mail may change authentication results. Preserve available authentication evidence, test the approved forwarding path, and hold suspicious events for internal review. No email content can authorize arbitrary CRM actions.

## Client configuration

| Setting | Required configuration |
| --- | --- |
| Source | Source ID, client/workspace, website/form label, intake alias or mailbox/folder and active state. |
| Parsing | Approved example emails, HTML/text format, sender/subject rules, field aliases, required fields and parser version. |
| CRM routing | Field mapping, initial stage, source tag, owner/team, duplicate policy and automatic-save or review mode. |
| Follow-up | Optional task delay in working days; optional internal notification and destination. Both off unless configured. |
| Operations | Secret references, review assignee, retention, polling/retry limits and connection health. |


## 17 Email processing and review rules

## Extraction and saving

- IN-04 Parse MIME and HTML/text safely; ignore scripts, tracking images and quoted correspondence. Map labelled form fields deterministically first. Optional model extraction must produce schema-validated fields with evidence; uncertain or changed templates go to review. Do not fetch embedded URLs or process attachments in MVP.

- IN-05 Extract visitor name, email, phone, company and enquiry text from form fields. Notification From is usually the website/mailer, not the lead. Use Reply-To only when the client template explicitly defines it as the visitor address. Capture source/form, received time and original submission ID/time if present.

- IN-06 Automatic-save default requires a matched, approved template, a name or company, at least one valid contact method and enquiry text. Store only supplied values. An email address passing syntax checks does not establish ownership. Missing required fields, conflicts, spam suspicion or uncertain parsing create an intake review item, not a normal sales opportunity.

- IN-07 Use a dedicated workspace integration role. A validated new submission creates or safely links Person/Company, creates the Opportunity in the configured stage and records the enquiry as a note. Use a neutral title derived from the supplied name/company. Record provenance and operation ID. Do not overwrite existing nonempty contact fields automatically.

## Duplicate and assignment behavior

- IN-08 Deduplicate delivery using provider event ID and mailbox identifiers. Prefer original form submission ID for business deduplication; otherwise use original Message-ID and a bounded normalized-content fingerprint to detect forwarding/retry copies. Scope all keys by tenant/source. Identical content alone must not suppress genuine repeat enquiries indefinitely.

- IN-09 Match contacts using normalized phone/email inside the tenant. Ambiguous or conflicting matches go to review. A distinct repeat enquiry reuses a confidently matched contact and follows the configured deal policy: review by default; append to a known open opportunity or create another only under an explicit client rule. Do not auto-merge companies by name.

- IN-10 Assign a designated active salesperson by default; optional round-robin must be atomic and idempotent. If no eligible owner exists, route to a client-admin review queue. Under a configured rule, create one follow-up task and optional employee notification only after the CRM write succeeds.

## Review and recovery

IN-11 Provide a tenant-restricted Intake Review object/view in Twenty, with status, source, proposed fields, reason and operation reference. Authorized managers/admins may correct, approve or reject. Chat approval uses the existing preview/confirmation flow. Poll approved review records or consume events to execute the same idempotent operation. Raw email/media access uses authorized links.

IN-12 Persist received → parsed → review or committing → committed/rejected/failed state. Retry transient errors and reconcile partial writes. No automatic reply, acknowledgement or marketing message goes to the visitor. Chat-driven changes retain their confirmation requirement; automatic intake is a configured service action.


## 18 Intake delivery and acceptance

## Implementation and operations

Add an email intake adapter and parser to the existing FastAPI/worker service, not another CRM deployment. Store source configuration, delivery IDs, processing state and mailbox checkpoints in the shared application database with tenant isolation. Use the existing workspace CRM adapter, operation journal and outbox. Restrict mailbox reads to the selected source; never delete or move original emails without explicit client configuration.

For webhook delivery, authenticate and durably enqueue before acknowledgement. For mailbox polling, use durable checkpoints with overlap and idempotent replay; renew subscriptions where applicable. Proposed target: CRM record or review item within five minutes of email availability under normal load, excluding upstream forwarding delays. Alert operators on stale connections, parser failures and backlog.

Proposed retention: raw email for 30 days and review items for 30 days before restricted archival/deletion according to client policy; retained CRM enquiry notes follow CRM retention. Record received/parsed/saved/review/failed timestamps and parser version. Reprocessing preserves the original operation ID to prevent duplicates. Do not use the chat draft’s 30-minute expiry for intake review.

## Additional acceptance tests

| ID | Passing condition |
| --- | --- |
| AT-16 | Client’s unchanged form sends an email; approved forwarding creates the correct contact, opportunity and note in that client’s workspace within the target time. |
| AT-17 | HTML and plain-text examples, international contacts and website From addresses parse correctly. Visitor contact details come from mapped form fields. |
| AT-18 | Mailbox retries, duplicate webhook delivery and forwarded copies create one enquiry/task/notification. A genuinely new enquiry from the same contact follows the configured repeat policy. |
| AT-19 | Spoofed sender, unknown route, malformed mail, changed template and prompt injection cannot select tenants or mutate records. Review exposes no other client’s data. |
| AT-20 | Missing fields and conflicting duplicates enter Intake Review. Authorized correction/approval commits once; rejection creates no sales opportunity. Restricted users cannot approve. |
| AT-21 | Configured owner/stage/source and optional task/notification apply. Disabled options produce no task/alert. No visitor receives an outbound message. |
| AT-22 | Expired mailbox token, missed event and CRM outage recover via checkpoint replay/reconciliation without data loss or duplicates. Operators receive a diagnostic alert. |

## Handoff additions

Deliver forwarding instructions, mailbox/provider setup, source manifest, parser fixtures and field mappings, review permissions/view, retry/replay runbook and AT-16–AT-22 results. Prove two clients with different email templates during feasibility and include email intake in the pilot. Confirm optional follow-up/notification rules during each client’s onboarding.
