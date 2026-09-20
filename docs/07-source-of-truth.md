# Source of truth

| Data | System of record |
| --- | --- |
| Company | Twenty |
| Person / contact | Twenty |
| Opportunity / lead stage / owner | Twenty |
| Tasks and sales notes | Twenty |
| Website research summary | Twenty (`Company.researchSummary` + Notes) |
| Outreach job status | Twenty OutreachJob (or Note footer if object missing) |
| Email delivery (bounces, message-id) | Email provider; copy of body in Twenty |
| WhatsApp transport | Meta | mapping in integration DB; content in Twenty |
| Teams thread | Teams | CRM mutations in Twenty |
| Website copy | Webflow / CMS |
| Worker secrets, queue, idempotency cache | Outreach env + Redis |

## Forbidden

Four copies of Rahul in four databases. If a channel needs a cache, it is a cache with a TTL and a Twenty id, not a customer record.
