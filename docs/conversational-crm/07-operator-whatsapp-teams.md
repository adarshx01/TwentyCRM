# Operator checklist: WhatsApp and Teams

The service is running locally before these steps. Gates **G1–G5 are still open**. Nothing below has been executed against a live Meta business or a live Teams tenant in this repo. Do not message customers or visitors. Bind only employee WhatsApp IDs and employee Teams user IDs.

Public internet is required before Meta or Azure can call the webhook. `http://localhost:3200` is not reachable from Meta or Microsoft. Put HTTPS in front of port 3200 (a tunnel or the container host) and use that origin below as `https://<public-host>`.

Do not commit tokens. Put them in the process environment or a secret store the tenant manifest points at with `env://` or `secret://`. `secret://` is not resolved until a vault is wired; `env://NAME` reads that variable.

Wiring (no secret values) is `GET http://localhost:3200/health`.

| Health field | Meaning |
| --- | --- |
| `whatsapp_configured` | Verify token, app secret, access token, and phone number id are all non-empty |
| `teams_configured` | App id and app password are both non-empty |
| `twenty` | `GET {TWENTY_BASE_URL}/healthz` returned a non-5xx response. Unreachable does not stop the process |

## Env vars

| Variable | Portal field |
| --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | String you invent. Paste the same string into Meta → WhatsApp → Configuration → Verify token |
| `WHATSAPP_APP_SECRET` | Meta app → App settings → Basic → App secret |
| `WHATSAPP_ACCESS_TOKEN` | Business settings → Users → System users → Generate token. Not the temporary token on API Setup |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → Phone number ID |
| `WHATSAPP_GRAPH_VERSION` | Version segment in `https://graph.facebook.com/<version>/<PHONE_NUMBER_ID>/messages`. Cloud API examples use `v26.0` (July 2026). Match the version selector in the Meta API reference |
| `WHATSAPP_TEMPLATE_NAME` | WhatsApp Manager → Message templates → template name, after status is Approved |
| `WHATSAPP_TEMPLATE_LANGUAGE` | That template’s language code, for example `en` |
| `TEAMS_APP_ID` | Entra → App registrations → Application (client) ID. Same value as the Azure Bot Microsoft App ID |
| `TEAMS_APP_PASSWORD` | Entra → Certificates & secrets → client secret Value (shown once) |
| `TEAMS_TENANT_ID` | Entra → Overview → Directory (tenant) ID, **only** for a single-tenant bot. Leave empty for multi-tenant so the token URL stays `https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token` |
| `TEAMS_SHARED_SECRET` | Not an Azure field. Local HMAC only, and only while `TEAMS_APP_ID` is empty |
| `WEBHOOK_SHARED_SECRET` | Not a Meta or Azure field. Signs `POST /intake/email`, `POST /intake/forms/{source_id}`, and the legacy chat envelope |
| `OPERATOR_TOKEN` | Bearer token for `POST /admin/tenants`. Not a Meta or Azure field |

Callback URLs:

- WhatsApp: `https://<public-host>/webhooks/whatsapp`
- Teams messaging endpoint: `https://<public-host>/webhooks/teams`

## WhatsApp (Meta Cloud API)

Baileys is not used. Production sends go to `https://graph.facebook.com/<WHATSAPP_GRAPH_VERSION>/<WHATSAPP_PHONE_NUMBER_ID>/messages` only when the access token and phone number id are set. Otherwise the send is recorded as `unconfigured` and Graph is not called.

1. **Business verification.** [business.facebook.com](https://business.facebook.com) → Settings → Business info / Security Center. Start business verification. Production messaging and higher limits stay blocked until Meta marks the business verified. This repo has not completed that step (gate G3).
2. **App.** [developers.facebook.com](https://developers.facebook.com/apps) → Create app → Business type → add the WhatsApp product. App mode can stay Development while you test with numbers added on API Setup. Live mode plus app review is required before messaging numbers that are not on the test list.
3. **Phone number.** WhatsApp → API Setup. Add a phone number that is not already on the consumer WhatsApp app, verify it with the SMS or voice code Meta shows, and wait until the number status is connected. Copy **Phone number ID** into `WHATSAPP_PHONE_NUMBER_ID`. The display number is not the id.
4. **System user token.** Business settings → Users → System users → Add → Admin or Employee. Add assets: the WhatsApp account, full control. Generate token. Permissions: `whatsapp_business_messaging` and `whatsapp_business_management`. Copy the token into `WHATSAPP_ACCESS_TOKEN` once. The 24-hour token on API Setup is not this value.
5. **App secret.** App settings → Basic → App secret → Show → `WHATSAPP_APP_SECRET`. Meta signs every POST as `X-Hub-Signature-256: sha256=<HMAC-SHA256 of the raw body keyed with this secret>`. A bad signature is HTTP 401. The service does not accept unsigned Cloud API posts.
6. **Verify token.** Choose a long random string. Put it in `WHATSAPP_VERIFY_TOKEN` and in WhatsApp → Configuration → Verify token. Callback URL: `https://<public-host>/webhooks/whatsapp`. Click Verify and save. Meta sends `GET` with `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`. The service returns the challenge as plain text only when the token matches. Then Webhook fields → Manage → subscribe to **messages**.
7. **Morning reminder template.** WhatsApp Manager → Account tools → Message templates → Create. Category **Utility**. Name, for example `morning_digest` (lowercase, underscores). Language, for example English → `en`. Body with one variable, for example `Follow-ups: {{1}}`. Submit and wait until the template status is **Approved**. Set `WHATSAPP_TEMPLATE_NAME=morning_digest` and `WHATSAPP_TEMPLATE_LANGUAGE=en`. Reminders outside the 24-hour customer service window use this template. Inside the window the service sends type `text`. If the template name is empty and the window is closed, the digest stays pending with `whatsapp_template_required` and Graph is not called.
8. **Allowlist employees only.** `POST /admin/tenants/{id}/memberships` with `channel=whatsapp` and `external_id` equal to the employee’s WhatsApp id (country code plus number, digits). The id Meta sends as `messages[].from` is the value to store. Do not put a customer number here. Outbound `to` is that binding, prefixed with `+`. There is no API to send to an arbitrary phone.
9. **Restart** the API and worker so they see the variables. `GET /health` should show `whatsapp_configured: true`. Send a WhatsApp message from the employee handset to the business number. The service answers HTTP 200 after the signature check, dedupes `messages[].id`, and enqueues. It does not extract inside the webhook request.

Development-mode apps only deliver webhooks for numbers listed under API Setup → To. That list is still employees, not a customer campaign.

## Teams (personal chat only)

Inbound Bot Connector calls are JWT-validated when `TEAMS_APP_ID` is set. OpenID metadata: `https://login.botframework.com/v1/.well-known/openidconfiguration`. Issuer `https://api.botframework.com`. Audience is `TEAMS_APP_ID`. The `serviceurl` claim must match the activity `serviceUrl`. The signing key must endorse `msteams`. Unsigned requests are rejected. A valid HMAC envelope is not accepted once `TEAMS_APP_ID` is set.

Group chats, team channels, and meeting chats are ignored (`private_chat_only`). Capture is a personal chat with the bot.

1. **App registration.** [Entra admin center](https://entra.microsoft.com) → Applications → App registrations → New registration. Name the bot. Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID tenant – Multitenant)**. Leave the redirect URI empty. Register.
2. **Ids.** Overview → Application (client) ID → `TEAMS_APP_ID`. Directory (tenant) ID → copy it aside. Put it in `TEAMS_TENANT_ID` only if you later change the bot to single-tenant. For this multi-tenant registration, leave `TEAMS_TENANT_ID` empty.
3. **Client secret.** Certificates & secrets → New client secret → copy the Value immediately → `TEAMS_APP_PASSWORD`.
4. **Azure Bot.** [Azure portal](https://portal.azure.com) → Create a resource → Azure Bot. Bot handle of your choice. Microsoft App ID: the `TEAMS_APP_ID` from step 2 (create the bot with an existing app, do not let the wizard mint a second app). Type: **Multi Tenant**. After it exists, Configuration → Messaging endpoint: `https://<public-host>/webhooks/teams` → Apply.
5. **Teams channel.** Azure Bot → Channels → Microsoft Teams → Save. This enables the Teams channel. It does not install the app for users.
6. **Teams app manifest.** Build a zip with `manifest.json`, `color.png` (192×192), and `outline.png` (32×32). `bots[0].botId` is `TEAMS_APP_ID`. Scopes are `personal` only.

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "<TEAMS_APP_ID>",
  "developer": {
    "name": "Recruitment Bricks",
    "websiteUrl": "https://<public-host>",
    "privacyUrl": "https://<public-host>",
    "termsOfUseUrl": "https://<public-host>"
  },
  "name": { "short": "CRM capture", "full": "CRM capture (employees)" },
  "description": {
    "short": "Employee CRM capture",
    "full": "Personal chat for allowlisted employees. No customer messaging."
  },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#FFFFFF",
  "bots": [
    {
      "botId": "<TEAMS_APP_ID>",
      "scopes": ["personal"],
      "supportsFiles": false,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity"],
  "validDomains": ["<public-host>"]
}
```

7. **Install.** [Teams admin center](https://admin.teams.microsoft.com) → Teams apps → Manage apps → Upload new app → upload the zip. Then setup policies or the app permission policy so only the employees who should capture CRM data can install it. Each of those employees opens a **personal** chat with the bot and sends one message. That request stores the conversation reference (`serviceUrl`, conversation id). Proactive reminders fail with `teams_reference_missing` until this happens. Do not add a team or groupChat scope.
8. **Admin consent.** This bot’s outbound token uses scope `https://api.botframework.com/.default` against the multi-tenant token URL above. It does not call Microsoft Graph. If someone adds Graph permissions on the registration later: Entra → App registrations → API permissions → Grant admin consent for the tenant. Do not grant broader Graph access for this checklist.
9. **Allowlist.** `POST /admin/tenants/{id}/memberships` with `channel=teams` and `external_id` equal to the activity `from.id` (a `29:` id), not the employee’s email and not a name typed in the message. Adaptive Card submits land in `activity.value` and use the same draft path as text. Tenant id is the binding, never a field in the card.
10. **Restart** and check `teams_configured: true`. A message in the personal chat should return HTTP 200. Customer or visitor chats are out of scope; do not install this app in a customer-facing channel.

## Email intake (no visitor reply)

The service has no mail sender. It will not auto-reply to a form visitor.

**Forwarding alias.** Create a source:

`POST /admin/tenants/{id}/intake-sources` with an opaque `alias` (not the tenant name), `mode` `review` or `auto`, and `actor_membership_id` of an employee membership.

Staff forward the labelled form to `intake+<alias>@<your-domain>`. A mailbox rule or inbound mail hook that you operate (this service does not poll IMAP) POSTs the raw RFC822 to:

`POST https://<public-host>/intake/email`

Headers: `X-Conversation-Timestamp` (unix seconds) and `X-Conversation-Signature: sha256=<hex HMAC-SHA256 of "{timestamp}:{raw body}">` using `WEBHOOK_SHARED_SECRET`. The `To` header selects the alias. A tenant id in the body is ignored.

**Signed form route** when the hook already knows the source:

`POST https://<public-host>/intake/forms/{source_id}`

Same signature headers. JSON body: `{"message_id":"<rfc822 id>","body":"Name: ...\nEmail: ...\nCompany: ...\nDomain: ...\nStage: NEW\n"}`. The source id is the route. The alias is not trusted on this path. `review` opens a draft and does not call Twenty. `auto` uses the same operation journal as chat confirm. Replays of the same message id return the original row.

## Allowlisted confirm path

After a draft exists, the employee (or a role allowed to commit for them) calls:

- `GET /drafts/{id}?channel=whatsapp&external_user_id=<binding>` for version and `content_hash`
- `POST /drafts/{id}/confirm` with that version, hash, channel, and external user id
- `POST /drafts/{id}/edit` with a replacement card
- `POST /drafts/{id}/cancel`

A Teams card submit may send `{"action":"confirm","draft_id":"...","version":1,"content_hash":"..."}`. The worker commits only if the binding is allowed to commit. Twenty is called with the workspace API key resolved from `twenty_api_key_ref`, never from the message.
