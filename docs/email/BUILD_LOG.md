# Email build log

One entry per runbook section, in the format of runbook D8.

## Section 0 — Discovery and preparation — DONE 2026-11-04T12:30:00Z
Built:
- `docs/email/SPEC.md`, `docs/email/EMAIL_MARKETING_BUILD_PROMPTS.md` (copied in), `docs/email/CONTEXT.md` (survey + mapping of the runbook onto this repo).
- `.gitignore`: `imports/`, `var/email-evidence/`, `apps/api/var/`.
- Env (`apps/api/src/config/env.ts`, `.env.example`): `EMAIL_SEND_MODE`, `EMAIL_TEST_ALLOWLIST`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`, `EMAIL_UNSUBSCRIBE_MAILTO`, `EMAIL_TOKEN_SECRET`, `SENDGRID_WEBHOOK_PUBLIC_KEY`, `BOUNCER_API_KEY`, `BOUNCER_API_BASE_URL`, `STOREFRONT_BASE_URL`, `ADMIN_BASE_URL`.
- Module skeleton `apps/api/src/modules/email/{lib,services,jobs,templates,public,mcp}` + README; `lib/config.ts`.
- `npm run test:email -w @smmta/api`; harness test `src/modules/email/harness.test.ts`.
Decisions taken:
- Branch is `claude/inspiring-feynman-e88jdq`, not `feature/email-marketing`: the session is required to develop on that branch.
- Test interception uses the repo's convention (injected fakes + `vi.stubGlobal('fetch')`) rather than adding msw/nock.
- Test database: a local Postgres 16 (`smmta_test`), the same arrangement CI uses; no extra compose service.
- `EMAIL_SEND_MODE` has no default in the schema: unset means "the sender refuses to run" (D3), and the UI shows it as sandbox. Unknown values fail validation. `.env.example` carries `sandbox`.
- `SENDGRID_WEBHOOK_PUBLIC_KEY` is accepted as an alias of the existing `SENDGRID_WEBHOOK_VERIFICATION_KEY`; `EMAIL_TOKEN_SECRET` falls back to `UNSUBSCRIBE_SECRET`.
- Interests are keyed on material/category keys, not category ids (CONTEXT.md "Interests").
- No linter exists in the API; "lint" in each section's checks = `tsc --noEmit` (api and web), as CI does.
Tests: 5 unit/integration (harness), repo API suite 1029 green before the build; all green
Commit: (this commit)

## Section 1 — Schema, consent log and the gate — DONE 2026-11-04T13:40:00Z
Built:
- `apps/api/src/db/schema/email.ts` + migration `0043_email_core.sql`: `email_contacts`, `email_consent_events`, `email_campaigns`, `email_sends`, `email_events`, `email_templates`, `email_imports`, `email_settings`, `email_rate_limit`; `customers.contact_id`.
- Triggers (hand-written in 0043): `email_consent_events` append-only (DELETE allowed only when the transaction sets `email.purge = 'on'`, for erasure requests); `email_contacts_status_guard` refuses an UPDATE that changes `marketing_status` unless a consent event for that contact and that new status exists with `txid = txid_current()`. Mechanism: `email_consent_events.txid` defaults to `txid_current()`; the service inserts the event and then updates the contact inside one transaction (or savepoint — savepoints share the top-level txid).
- `modules/email/lib/gate.ts` (`canSend`, class table as data, UK send window), `lib/settings-defaults.ts`, `lib/interests.ts`, `lib/normalise.ts`, `lib/db.ts`, `services/settings.service.ts`, `services/contacts.service.ts`, `services/backfill.service.ts`, `scripts/email/backfill-contacts.ts`, `testing.ts` (fixtures + cleanup).
Decisions taken:
- Four email classes in the schema (`order_required`, `requested_service`, `service`, `marketing`) rather than transactional/marketing: the spec's class table has four rows and the gate needs them. SendGrid categories still carry the two-way split (section 6).
- Columns later sections need on `email_contacts` (`digest_enabled`, `new_product_alerts_enabled`, `last_digest_at`, `preferred_hour`, `soft_bounce_since`) and on `email_sends` (`not_before`, `attempts`, `variant`) are created now so one migration carries the core model.
- Settings defaults live in code (`settings-defaults.ts`); the first read writes any missing key to `email_settings`, so the table always shows the full set without a second source of truth in SQL.
- Backfill reads addresses from customers, storefront users, newsletter subscribers and back-in-stock requests (all are addresses the store holds). `all` only from an active newsletter subscription or a latest `general_marketing` consent grant; the existing `suppression_list` carries across (unsubscribe/complaint → `transactional_only`, bounce → `hard_bounce`, complaint → `complained`). Interests/last order are computed only for contacts the run creates, which is what makes a second run a no-op.
- `is_trade` rule (Part B #11): no trade-discount tier exists on customers, so trade = a storefront user of kind `trade`, or any order with ≥ 10 of one SKU.
- Engagement for the unengaged rule counts clicks and orders, not opens (spec: opens are a weak signal under Apple MPP); the caller supplies the streak.
- A hero campaign's `override_gap` skips the 7-day gap but never the 24-hour floor.
Tests: 93 unit (gate 60-cell matrix + marketing gates + window, normalise, interests), 37 integration (transitions table, trigger, deliverability, interests, backfill on 20 customers ×2 runs); API suite 1164 green
Commit: (this commit)
