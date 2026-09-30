# Channels and intake

## Adapter interface

`NormalizedInboundEvent` is the only inbound shape: channel, external user id, provider message id, text, and an optional structured card. WhatsApp and Teams routes verify the caller, persist and dedupe the provider message id, enqueue, and return. Extraction and Twenty writes happen on the worker, not inside the webhook.

- WhatsApp is the Meta Cloud API. `GET /webhooks/whatsapp` answers the `hub.challenge`. `POST` with `X-Hub-Signature-256` is HMAC-SHA256 of the raw body using `WHATSAPP_APP_SECRET`. Baileys is not a dependency. Sends use the Cloud API only when the access token and phone number id are set; otherwise the result is `unconfigured` and Graph is not called. Session text is used inside 24 hours of the employee’s last message. Reminders outside that window require `WHATSAPP_TEMPLATE_NAME`.
- Teams is a Bot Framework bot. Personal chat only. When `TEAMS_APP_ID` is set, inbound requests must carry a Bot Connector JWT (issuer `https://api.botframework.com`, audience the app id, `serviceurl` matching the activity). Adaptive Card submits (`activity.value`) enter the same draft flow as text. Proactive messages use the stored conversation reference. Group and channel conversations are ignored.

The operator click-path, env var map, and Teams manifest are in [the checklist](07-operator-whatsapp-teams.md). Gates G3 and G4 stay open until that checklist is done against a live Meta business and a live Teams tenant.

A legacy signed envelope is still accepted for local tests when it is not a Cloud API or Bot Connector request:

`POST /webhooks/whatsapp` and `POST /webhooks/teams` with the legacy envelope require:

- `X-Conversation-Timestamp`
- `X-Conversation-Signature: sha256=<hex hmac-sha256 of "{timestamp}:{raw body}">`

The secret is `WEBHOOK_SHARED_SECRET`. Empty secret fails closed. Timestamps outside five minutes are rejected. A repeated provider message id returns a duplicate acknowledgement and does not enqueue a second job.

`POST /intake/email` and `POST /intake/forms/{source_id}` use the same HMAC. The form route takes the source id from the URL. The email route takes the alias from `To`. Neither route sends a reply to the visitor. See the [checklist](07-operator-whatsapp-teams.md) for the forwarding-alias hook.

## Intake (IN-01–12)

Staff forward a labelled form email to an opaque per-client alias (`local-part` or `local+alias` on the `To` header). The alias is looked up in `intake_sources`. It is not a guess from the body.

```text
To: intake+7f3a@intake.example
Message-Id: <unique@mail>

Name: Ada Lovelace
Email: ada@example.com
Company: Analytical Engines
Domain: analytical.example
Stage: NEW
```

| Rule | Behaviour |
| --- | --- |
| IN-01 | Alias is opaque; it is not the tenant name |
| IN-02 | One alias maps to one source and therefore one tenant |
| IN-03 | `(tenant, message id)` is unique; a replay returns the original row (AT-18) |
| IN-04 | Labelled lines only; the parser does not scrape free prose into CRM fields |
| IN-05 | Unknown proposal keys fail the same schema as chat |
| IN-06 | `review` creates `awaiting_confirmation` and does not call Twenty |
| IN-07 | `auto` journals only when the proposal is valid and the source actor may commit |
| IN-08 | Unknown stage does not write CRM records |
| IN-09 | Unknown alias returns `unknown` and does not open a draft (AT-19) |
| IN-10 | No visitor reply is sent (SEC-05). Intake has no mail sender |
| IN-11 | Auto commit uses the same operation journal as chat confirm |
| IN-12 | A tenant id written in the body is not a routing key |

## Operator API

`POST /admin/tenants` requires `Authorization: Bearer <OPERATOR_TOKEN>`. It creates the tenant row and stores the manifest version and secret reference. Membership, enrollment, and revocation routes live under `/admin/tenants/{id}/…`.
