Writing the same content to the repo so it travels with the code.

The two diagrams are above: the logical architecture, then the AWS deployment. The same content with rationale and the production path is in [docs/architecture-overview.md](docs/architecture-overview.md). One line in the logical diagram has a stray duplicate coordinate; it rendered fine and I left it.

## Why this design is good

| Decision | Why it holds up |
|---|---|
| Twenty stays the system of record and Bee is a layer on top | There is no CRM fork to maintain, and Twenty upgrades independently. CXOs and admins still use native Twenty screens. |
| One workspace per company, plus `tenant_id` row security in Bee | Two independent isolation layers, so a bug in one does not leak data. The live test confirmed that one company's credentials reveal none of another's data. |
| Transactional outbox with BullMQ | A confirmed capture is never lost between "saved" and "queued". Retries are idempotent. |
| Draft, confirm, then write | The model never changes the CRM on its own. A human approves, and the audit trail shows who. |
| Capability matrix and a separate operator principal | Operators run the service without seeing customer records. Support access is client-approved, time-boxed and audited. |
| Per-tenant derived secrets and an encrypted vault | A credential from company A cannot act for company B, and nothing per tenant sits in plaintext config. |
| Stateless Bee containers, one-host Compose behind Caddy | Cheap and reproducible while the product is proven. Scaling out means adding copies. |
| SSM instead of SSH, secrets in Secrets Manager | No open admin port, and no secrets in images or user-data. |

## How to improve it for production

1. **Availability.** Move the Bee containers to ECS Fargate behind an ALB. Use RDS or Aurora multi-AZ for Twenty's databases and ElastiCache for Redis with AOF on.
2. **Real domain and TLS.** Replace sslip.io with your own domain, Route 53 and an ACM wildcard certificate.
3. **Licence.** Get a Twenty Organization key to lift the 5-workspace cap. Without it, run a second multi-workspace Twenty.
4. **Scale and fairness.** Run separate worker pools per queue that autoscale on queue depth. Add per-tenant fair scheduling (BRD TEN-05), since the inbound queue is first-in-first-out today.
5. **Security.**
   - Put a WAF in front and move everything except the load balancer into private subnets.
   - Add VPC endpoints, KMS-encrypted volumes and secret rotation.
   - Export audit logs to immutable storage (S3 Object Lock).
   - Enforce SSO and MFA for operators.
6. **Per-tenant WhatsApp.** Give each tenant its own number and token. The manifest field (`channels.whatsapp.accessTokenRef`) exists but is not wired through the console.
7. **Operations.**
   - Add OpenTelemetry traces, plus alerts on queue lag, dead letters, webhook failures and channel health.
   - Run restore drills and tenant-relocation rehearsals.
   - Deploy blue/green with automatic rollback, and run `scripts/verify/platform.mjs` as a post-deploy gate.
8. **Product.** Add a "remove company" action, usage limits and billing hooks, bulk user import, and the 30-minute load test against the BRD targets.





The WhatsApp code is already built and tested against fakes, but it has never run against a live WhatsApp account. Going live is Meta setup plus four configuration values in AWS.

## 1. Meta side (you do this)

1. **Create a Meta developer app.** Go to developers.facebook.com, create an app of type **Business**, and add the **WhatsApp** product. You need a Meta Business account.
2. **Get a phone number.** Use Meta's test number to start, or register a real number. A number already on the WhatsApp app must be migrated and cannot be used in both places.
3. **Collect these four values** from WhatsApp → API Setup:
   - **Phone number ID**
   - **Access token.** Create a permanent one: Business Settings → System Users → add a system user → generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`. The temporary token expires in 24 hours.
   - **App secret** (App settings → Basic).
   - **Verify token**, which you invent yourself (any long random string).
4. **Create and submit a message template** for reminders (category Utility). Meta needs to approve it before Bee can send outside the 24-hour reply window. Note its name and language.

## 2. Bee side (configuration)

Add these to the `bee.env` section of the AWS secret `crmbee/env`:

```
WHATSAPP_VERIFY_TOKEN=<the string you invented>
WHATSAPP_APP_SECRET=<app secret>
WHATSAPP_ACCESS_TOKEN=<system-user token>
WHATSAPP_PHONE_NUMBER_ID=<phone number id>
WHATSAPP_GRAPH_VERSION=v21.0
WHATSAPP_TEMPLATE_NAME=<approved template name>
WHATSAPP_TEMPLATE_LANGUAGE=en
```

Then run `./deploy/aws/release.sh` so the containers pick up the new values.

## 3. Register the webhook in Meta

WhatsApp → Configuration → Webhook:
- **Callback URL:** `https://bee.3-6-13-47.sslip.io/webhooks/whatsapp`
- **Verify token:** the same string as `WHATSAPP_VERIFY_TOKEN`
- **Subscribe** to the `messages` field.

The Bee host exposes only `/webhooks/*` and `/health` publicly, so this URL is reachable. A 403 on verification means the tokens differ.

## 4. Enroll each person

A person is linked to their WhatsApp number by a one-time code, not by typing their number in:
1. The client admin opens **Bee → Users** in the company workspace and issues a WhatsApp enrollment code for the user (valid 60 minutes, single use).
2. The employee sends `BEE-XXXX-XXXX` from their own WhatsApp to the business number.
3. The binding appears and Bee replies. From then on they can capture leads by text, voice or photo, confirm drafts, and get morning reminders.

## 5. Check it end to end

- Meta's **Verify and save** on the webhook succeeds.
- Send the enrollment code and confirm the binding shows under the user.
- Send "Create a lead: Rajesh Kumar, ABC Industries"; Bee should reply with a draft to confirm.
- Check `channel_connection_health{channel="whatsapp"}` in the metrics, which is 1 when the token works.

## Things to know

- **One number for all companies.** The current setup uses one shared platform number, and Bee tells companies apart by the enrolled employee. Separate numbers per client would need a per-tenant token reference, which the manifest already supports (`channels.whatsapp.accessTokenRef`) but is not wired through the console.
- **24-hour rule.** Outside the 24-hour window Meta only allows approved templates, so morning reminders won't send until the template is approved.
- **Not yet verified live.** Every step above is exercised in tests against fakes. Expect to debug the first real round trip together.

If you want, send me the four values (or put them in the secret yourself) and I'll do steps 2 and 3 and run the first live test with you.