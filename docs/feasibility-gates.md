# Feasibility gates (BRD §1) — what the code proves and what needs a live system

| Gate | Evidence in this repository | **Still required against live systems** |
|---|---|---|
| **G1 Tenant isolation** | RLS enforced as a non-superuser; connection-context-reset test; cross-tenant ids → 404; per-workspace Twenty tokens; fake Twenty rejects a key used on another workspace | Two real Twenty workspaces: UI/API/search/attachment isolation; first-signup restriction; controlled provisioning (`IS_MULTIWORKSPACE_ENABLED`, wildcard DNS/TLS) |
| **G2 Permissions & licensing** | Service-side scope for search, counts, summaries, related records, notes, assignment (tests AT-02) | Native row-level permissions in the UI for salesperson/manager/CXO; hosted-service licensing terms (Organization plan) — **commercial decision** |
| **G3 Pipeline configuration** | Manifest → SELECT options, idempotent re-run, stable IDs, previewed stage migration (tests) | Run `ensureSchema` against the pinned release; confirm metadata API coverage; document admin steps where absent (CFG-02) |
| **G4 Channel capabilities** | WhatsApp: signature, normalization, template-outside-window, receipts, opt-out. Teams: JWT guard, Adaptive Cards, proactive sender, install/uninstall. All tested with fakes | Real-device card + voice capture (WhatsApp, Teams mobile), Teams private-chat file path, native Teams voice-note retrieval, WhatsApp reminder outside the reply window with an *approved* template, Meta fees |
| **G5 Reliability** | Journal, timeout-after-create, lease takeover, worker kill/restart, duplicate confirm/webhook, races (tests AT-04, AT-13) | Repeat on staging with real Twenty latency and a real `kill -9` |

Also verify before fixing a price (BRD): Twenty rate-limit scope/configurability; Teams SDK/auth for multiple customer tenants;
STT/vision accuracy on the 100 cards + 50 voice notes (Indian accents, noise); Twenty ↔ GCS S3-interop (or deploy an S3
layer); retention/data-processing terms with the AI provider.
