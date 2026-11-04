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

## Section 2 — Unsubscribe and preferences pages — DONE 2026-11-04T14:20:00Z
Built:
- `modules/email/lib/tokens.ts` (stored unsubscribe tokens; HMAC-SHA256 signed links with expiry, constant-time compare), `lib/headers.ts` (`marketingHeaders`, RFC 2369/8058), `lib/ip-rate-limit.ts` (30/min per IP).
- `modules/email/public/pages.ts` + `public.routes.ts`: `GET/POST /email/u/:token` (one-click POST → 200 empty, also for unknown tokens; `confirm=1` form → result page), `GET/POST /email/preferences/:token` (interests per material, weekly email, new-product alerts, marketing on/off). Registered in `app.ts` at `/email/*` and `/api/email/*`. `noindex` meta + `X-Robots-Tag`, no scripts, no-store.
- Storefront pass-through `app/email/[...path]/route.ts` in `apps/store` and `apps/store-clothes`, so the links live on the shop's domain (STOREFRONT_BASE_URL).
Decisions taken:
- The pages are rendered by the API and proxied by the storefront at request time (a Route Handler, not a `next.config` rewrite: the API address is only known at runtime in Docker, and rewrites are baked in at build). One implementation serves both shops.
- `digest_enabled` / `new_product_alerts_enabled` were created in section 1's migration; the gate already treats them as reasons for `weekly_digest` / `new_product` only.
- Unknown tokens: one-click and confirm POSTs answer 200 and write nothing; the GET confirm page renders without an address; the preferences page answers 404 with a generic "link expired" page.
- Ticking a material on the preferences page sets its interest just above the "interested" threshold (unless already higher); unticking removes it. Unticking everything (or the marketing box) = unsubscribe.
- The browser test drives real Chromium (`/opt/pw-browsers/chromium` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`) with requests routed into the app via `inject`; it skips where no browser exists (the API CI job installs none). `@playwright/test` added to the API's devDependencies.
- Checked live: `curl -X POST -d 'List-Unsubscribe=One-Click' http://127.0.0.1:8099/email/u/<token>` → 200 and the contact became `transactional_only`.
Tests: 4 unit (headers, signed links), 12 integration (routes), 2 e2e (Chromium, 375 px, JS off), 3 storefront proxy; all green
Commit: (this commit)

## Section 3 — Move back-in-stock onto the gate — DONE 2026-11-04T15:10:00Z
Built:
- `modules/email/services/sends.service.ts` (`SendsService.enqueue` = runbook `enqueueSend`: gate → one `email_sends` row, queued or dropped with the reason; idempotent on the key; roll-up helpers; `unengagedStreak`).
- `modules/email/services/sender.service.ts` — section 3 stub sender (sandbox: marks due rows sent; refuses when `EMAIL_SEND_MODE` is unset). Replaced in section 6.
- `modules/email/services/back-in-stock.service.ts`: `GateNotifyMeSender` (the `NotifyMeSender` the GRN now uses) and `BackInStockService` (daily re-check, 180-day close).
- Migration `0044_email_back_in_stock.sql`: `stock_notifications.contact_id`, `.email_send_id`, `.close_reason`.
- `NotifyMeService.record` creates the requester's contact (source `back_in_stock_form`, no marketing consent) and adds +10 interest for the product; `fulfilForProduct` passes the request id. `GRNService.notifyMeSender` defaults to `GateNotifyMeSender`; the old HTTP sender to the storefront route is removed.
- Worker: `modules/email/jobs/schedule.ts` + `jobs/handlers.ts`; `ScheduledJob.tz` added and passed to `boss.schedule` (UK local time). Jobs: `email-send` (every minute), `email-bis-recheck` (08:55 UK), `email-close-stale-bis` (03:35 UK).
Decisions taken:
- Back in stock is class `requested_service` (the runbook's "transactional"): the spec's class table puts it there — `transactional_only` contacts get it, `never` and bad addresses do not.
- Queue names use hyphens (`email-send`) like the worker's other queues; the runbook writes `email.send`.
- No pg-boss publish per row: the API process does not run pg-boss; the every-minute `email-send` job drains due rows (runbook section 6 item 4 calls for that cron anyway).
- Roll-up: a contact with only one open request is sent straight away; a contact with other requests open gets one send at the next 09:00 UK that every further item joins until it goes. This satisfies both "single request immediate" and "one email listing all that came back today".
- 24-hour rule: a contact sent a back-in-stock email for the same product in the last 24 hours is not sent another; the request stays open and the daily re-check (which also covers stock that arrived other than through a GRN) sends it after the 24 hours.
- A request closes when its send is queued *or* dropped by the gate (one email per request; "closes on send"). Expired requests are soft-deleted with `close_reason = 'expired'` so the customer can re-enrol.
- Registering the `back_in_stock` row in `email_templates` and the new layout are done with the rest of the templates in section 7 (the stub sender renders nothing).
- Deep link: IDEAS.md tracks the section 9 switch to the add-to-cart link.
Tests: 8 integration (back in stock), existing notify-me (11) and GRN (8) tests unchanged and green; API suite 1189 green
Commit: (this commit)

## Section 4 — CSV importer — DONE 2026-11-04T16:30:00Z
Built:
- `modules/email/services/imports.service.ts`: streaming `csv-parse`, batches of 500 in one transaction each, header detection (`detectColumns`), created-at parsing (unix seconds / ISO / `YYYY-MM-DD HH:MM:SS`), per-row interests (`rowInterests`), dry run → live run gated on a matching dry run (same SHA-256 and list type), live re-run of an imported file = no-op report, evidence copy to `EMAIL_EVIDENCE_DIR/<sha256>-<filename>`, report shape per runbook (conflicts masked, first 50).
- `scripts/email/import.ts` (CLI; dry run by default, `--live --dry-run-id`).
- Fixtures: `apps/api/test/fixtures/email/sendgrid/*.csv` (synthetic, @example.com).
- `EMAIL_EVIDENCE_DIR` env; Coolify compose files (full and back-office) give the api and worker the email env vars and a private `email-evidence` volume.
- Migration `0045_email_links_set_null.sql`: every link between email rows and customers / storefront users / back-in-stock requests is `ON DELETE SET NULL` — a contact (and its consent history) outlives the customer row it was linked to; found when another suite's customer clean-up was blocked.
Decisions taken:
- Consent events written by an import use source `csv_import`; new contacts' `consent_source` is the upload's (default `sendgrid_import`).
- A `never` contact is left completely alone by an import (status and deliverability); it is reported as a `never_unchanged` conflict.
- An import cannot set `never` as its default status (refused): only an operator sets that, per contact.
- Interests from an import are applied to the contacts it creates, at the "interested" score (3). Existing contacts' interests are not changed by imports.
- Deliverability: a complaint is never replaced by a bounce.
- Real exports absent: the dry and live runs of step 7 could not run (BLOCKERS B1). The four-file order is proven on fixtures.
Tests: 9 unit (six layouts, row helpers), 6 integration (four-file sequence, downgrade with evidence, re-run no-op, dry-run refusals, unknown layout, evidence copy); API suite 1218 green
Commit: (this commit)

## Section 5 — Bouncer verification — DONE 2026-11-04T16:45:00Z
Built:
- `modules/email/lib/bouncer.ts`: `verify` (10 s timeout) and `verifyBatch` (create → poll every 30 s up to 2 h → download); 429/5xx/timeouts are retryable `BouncerError`s; the key is never logged.
- `modules/email/services/verification.service.ts`: `verifyContact` (90-day cache, verify sources only), `apply` (undeliverable → `invalid`; risky stored; unknown retried once after 24 h then risky), `retryUnknown`, `reverifyDormant` (batch, waits).
- New domain event `email.contact_created`, emitted inside the contact-creating transaction for sources checkout / signup_form / back_in_stock_form / pre_order / subscription → worker queue `email-verify` (3 retries, backing off). Daily `email-verify-retry` job (04:20 UK).
- Fixtures `apps/api/test/fixtures/email/bouncer/*.json`.
Decisions taken:
- Verification is queued through the outbox (a domain event in the same transaction as the contact) rather than a hook after commit: the API process does not run pg-boss, and the outbox guarantees the job exists if and only if the contact does.
- Fixtures are synthetic, shaped after Bouncer's v1.1 documentation (the build never calls the real API); the endpoints should be confirmed against Bouncer's docs before go-live (HANDOVER).
- No `BOUNCER_API_KEY` → verification is skipped (logged), never an error.
Tests: 8 unit (client: four statuses, timeout, 429/500/401, no key, batch), 7 integration (event on create, source and cache skips, undeliverable vs the gate, risky soft bounce, unknown retry, dormant batch); every Bouncer request asserted to hit the stub; API suite 1218 green
Commit: (this commit)
