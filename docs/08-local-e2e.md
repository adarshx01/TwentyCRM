# Local dry-run (verify the milestone)

Goal: Twenty is up, a deal exists, outreach writes an **Outreach draft** Note. No real email.

## 1. Start Twenty

```bash
cd infra/twenty
./scripts/up.sh
curl -sf http://localhost:3000/healthz
```

Open [http://localhost:3000](http://localhost:3000), create the Recruitment Bricks workspace.

## 2. API key

Settings → APIs & Webhooks → create key → copy once.

```bash
cd apps/outreach
cp .env.example .env
# set TWENTY_API_KEY
# OPENAI_API_KEY optional; template fallback works without it
# OUTREACH_SEND_ENABLED must stay false
```

## 3. Seed fields (or click the playbook)

```bash
cd apps/outreach
npm install
npm run seed:crm
```

If Metadata API rejects a field type, finish those fields in Settings → Data Model using `src/seed/PLAYBOOK.md`. Stages and `outreachMode` matter; `researchSummary` is optional (the worker still writes a Note).

## 4. Start outreach

Twenty Redis must be listening on `127.0.0.1:6379` (compose publishes it).

```bash
cd apps/outreach
npm run start:dev
# health
curl -sf http://localhost:3100/health
```

## 5. Create a deal in Twenty

1. Company: name `Acme Technologies`, domain `acme.com` (a real site you are allowed to fetch, or any domain — fetch failure still drafts).
2. Person: email `rahul@acme.com`, linked to Acme.
3. Opportunity: name `Acme — VoiceBot`, stage **New**, company Acme, point of contact Rahul. Set `solutionInterest` to VoiceBot and `outreachMode` to Draft if those fields exist.

Copy the Opportunity id from the URL (`/object/opportunity/{id}`).

## 6. Run outreach

```bash
curl -sS -X POST http://localhost:3100/outreach/run \
  -H 'Content-Type: application/json' \
  -d '{"opportunityId":"PASTE_UUID"}'
```

Expect `202` with a job id. Watch outreach logs: research (or fallback) → draft.

## 7. Confirm in Twenty

On the Opportunity (and/or Company/Person):

- Note titled like `Outreach draft — 2026-09-21`
- Task `Review outreach`
- Company `researchSummary` filled when the field exists and fetch succeeded

No email leaves the machine (`OUTREACH_SEND_ENABLED=false`).

## 8. Idempotency

Run the same `curl` again. Second run should skip (`already drafted`) rather than create a duplicate step-1 draft.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Twenty never healthy | `docker compose logs server` — RAM, `ENCRYPTION_KEY`, migrations |
| 401 from outreach | `TWENTY_API_KEY`, `TWENTY_BASE_URL=http://localhost:3000` |
| Redis connection | `redis://127.0.0.1:6379/1`, Twenty stack up |
| Note not linked | Twenty morph fields; worker tries `targetOpportunityId` then `opportunityId` |
| Webhook never fires | Use manual `/outreach/run` locally; webhook URL must be `host.docker.internal` |
