# Outreach worker

NestJS service that:

1. Loads an Opportunity (and Company / Person) from Twenty
2. Fetches the company website (homepage + `/about`)
3. Drafts a personalized email (OpenAI if `OPENAI_API_KEY` is set, otherwise a template)
4. Writes a Note + Review task onto the Opportunity
5. Sends only when `outreachMode=AUTO` **and** `OUTREACH_SEND_ENABLED=true`

## Setup

```bash
cp .env.example .env
# TWENTY_API_KEY from Twenty Settings → APIs & Webhooks
npm install
npm run seed:crm    # or finish src/seed/PLAYBOOK.md in the UI
npm run start:dev
```

Twenty Redis must be up (`infra/twenty` publishes `127.0.0.1:6379`).

Health: http://localhost:3100/health

The browser at `/` shows a status page (this is not the Twenty CRM UI). Production: `npm run build && npm start` (or the `Dockerfile`). Railway/Render: [docs/09-hosting.md](../../docs/09-hosting.md). If `OUTREACH_API_TOKEN` is set, `/outreach/run` requires `Authorization: Bearer <token>`.

## Run one deal

```bash
curl -sS -X POST http://localhost:3100/outreach/run \
  -H 'Content-Type: application/json' \
  -d '{"opportunityId":"<uuid>"}'
```

Full dry-run: [docs/08-local-e2e.md](../../docs/08-local-e2e.md)

## Tests

```bash
npm test
```
