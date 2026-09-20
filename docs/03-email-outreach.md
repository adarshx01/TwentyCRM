# Email outreach

Twenty owns **who** the customer is and **whether** we may still write. The outreach worker owns **research + copy + optional send**. Twenty SMTP is for product/invite mail later, not campaigns.

## Modes

| Mode | Opportunity field | Env | Behavior |
| --- | --- | --- | --- |
| Draft (default) | `outreachMode = DRAFT` or unset | — | Research + LLM (or template). Write Note `Outreach draft — …`. Create Task `Review outreach`. **Do not send.** |
| Auto | `outreachMode = AUTO` | `OUTREACH_SEND_ENABLED=true` | Same research, then send via Resend/SMTP, Note `Outreach sent — …`, move `NEW` → `CONTACTED`. |
| Auto requested, send disabled | `AUTO` | `OUTREACH_SEND_ENABLED=false` (local default) | Behaves as draft. Logs the would-be email. |

## Flow

```text
Trigger (webhook or POST /outreach/run)
  → enqueue (BullMQ), idempotency key = opportunityId + sequenceStep
  → load Opportunity + Company + Person
  → stop conditions? → SKIPPED
  → resolve website (Company domain / website / email domain)
  → GET homepage + /about (timeout, size cap)
  → extract readable text
  → write Company.researchSummary
  → LLM JSON { subject, bodyText, whyThisAngle }
  → DRAFT note (+ task) or SEND
```

## Research rules

- Not a crawler farm: homepage and `{origin}/about` only.
- Timeout ~8s, cap ~500 KB HTML, follow a small number of redirects.
- Skip `mailto:`, file URLs, and consumer mail domains.
- If fetch fails, still draft from name + domain + `solutionInterest`.
- `researchSummary` is factual (what they do, hiring/ATS hints). No invented metrics.

## Compose rules

Prompt inputs: RB product one-liners, `solutionInterest`, research, contact name, `buyerRole`.

Output JSON only:

```json
{
  "subject": "...",
  "bodyText": "...",
  "whyThisAngle": "..."
}
```

Hard rules for the model (and the template fallback):

- No fake customer logos, case studies, or pricing.
- Short: ~120–180 words.
- One CTA: book a Recruitment Bricks demo (`https://recruitmentbricks.ai/request-a-demo`).
- Include an `{{unsubscribe}}` line (replaced on send; left as text in drafts).
- If `OPENAI_API_KEY` is missing, use the deterministic template so local dry-run still works.

## Sequence (this milestone = step 1 only)

| Step | When | Intent |
| --- | --- | --- |
| 1 | Trigger | Personalized first touch from website research |
| 2 | later | Wait ~2 days if no reply |
| 3 | later | Wait ~5 more days |
| 7d | later | Task for human follow-up |

Stop the sequence on reply, meeting booked, `stopOutreach`, or closed stages.

## Compliance (India + outbound)

- Send only to business contacts you have a legitimate reason to contact.
- Honor unsubscribe; set `stopOutreach` and do not mail again.
- Store sent copy on the Opportunity (Note), not only in the ESP.
- DPDP: keep personal data in Twenty; outreach logs should not copy full CRM dumps.

## Triggers

**Manual (always works locally)**

```http
POST http://localhost:3100/outreach/run
Content-Type: application/json

{ "opportunityId": "<uuid>" }
```

Optional: `{ "personId": "<uuid>" }` — worker finds an open Opportunity for that person/company or errors clearly.

**Webhook (Twenty → worker)**

URL for Dockerized Twenty talking to the host:

`http://host.docker.internal:3100/internal/twenty/webhook`

Verify `X-Twenty-Webhook-Signature` and `X-Twenty-Webhook-Timestamp`. Enqueue `opportunity.created` / `opportunity.updated` when stage is `NEW` and no draft exists yet. Respond 2xx immediately.

## Idempotency

Key: `{opportunityId}:{sequenceStep}`.

If a Note footer or OutreachJob already shows `DRAFTED`/`SENT` for that key, skip. Twenty may retry webhooks.

## ESP

| Env | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Preferred send path |
| `SMTP_*` | Fallback |
| neither, or send disabled | Log only |
