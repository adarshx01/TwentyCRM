# Website Solutions (spec only — not implemented in this repo)

`https://recruitmentbricks.ai/solutions` currently 404s. The marketing site appears to be Webflow. Completing Solutions is a **content + form contract** for whoever edits Webflow. This repo does not patch the live site.

## Information architecture

```text
/solutions
  ├── /solutions/action-enabled-system
  ├── /solutions/voicebot
  ├── /solutions/resume-analyzer
  ├── /solutions/whatsapp-calling
  ├── /solutions/reverse-match
  ├── /solutions/career-pages
  └── /solutions/analytics
```

Index page: one card per module, each with a primary CTA **Request a demo**.

## Page outline (every detail page)

1. Hero — outcome in one sentence + CTA
2. Problem — recruiter pain
3. Solution — what RB does
4. Features — 4–6 bullets
5. Use cases — TA team / high-volume / internal mobility as relevant
6. How it works — 3–5 steps
7. CTA band — Request demo / Talk to sales

## Module copy seeds

| Slug | `solutionInterest` | One-liner |
| --- | --- | --- |
| `action-enabled-system` | `AES` | Next-best action, then execute it in one click |
| `voicebot` | `VOICEBOT` | AI voice pre-screen and structured L1 |
| `resume-analyzer` | `RESUME_ANALYZER` | Explainable JD–resume match |
| `whatsapp-calling` | `WHATSAPP` | Engage candidates on WhatsApp after voice |
| `reverse-match` | `REVERSE_MATCH` | Internal mobility against open reqs |
| `career-pages` | `CAREER_PAGES` | Broadcast jobs / employer brand |
| `analytics` | `ANALYTICS` | Pipeline, velocity, source quality |

Keep Webflow copy aligned with the product, not generic “marketing automation” leftovers on the current homepage pricing cards.

## Lead form contract (future `POST /api/leads`)

When the integration API exists, every CTA form should POST JSON:

```json
{
  "name": "Rahul Sharma",
  "company": "Acme Technologies",
  "email": "rahul@acme.com",
  "phone": "+91...",
  "solution": "VOICEBOT",
  "message": "Need enterprise voice screening",
  "source": "website",
  "landingPage": "/solutions/voicebot",
  "utmSource": "linkedin",
  "utmMedium": "paid",
  "utmCampaign": "voicebot-sept",
  "referrer": "https://linkedin.com/"
}
```

Validation: CAPTCHA or rate limit, email + phone format, required name/email/company.

Then: duplicate detection → Company / Person / Opportunity `NEW` → assign → (later) Teams notify + outreach draft.

Until that API exists, Webflow can keep using its native form email, but store UTM hidden fields so nothing is lost.

## Attribution fields on the Opportunity

`source`, `utmSource`, `utmMedium`, `utmCampaign`, plus a Note with raw message + landing page.
