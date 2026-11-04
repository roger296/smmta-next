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

## Section 6 — Sender job, SendGrid client, event webhook — DONE 2026-11-04T18:20:00Z
Built:
- `modules/email/lib/sendgrid.ts`: pure `buildPayload` (custom_args, categories `[transactional|marketing, class, kind]`, List-Unsubscribe headers on marketing only, click/open tracking on, subscription tracking off, sandbox per mode) + `SendGridTransport` (429/5xx/network retryable, other 4xx permanent with the body).
- `modules/email/lib/rate-limit.ts`: token bucket in `email_rate_limit`, row-locked `takeTokens`.
- `modules/email/services/sender.service.ts` (replaces the section 3 stub): refuses with no send mode; takes tokens for due rows; leases rows (`FOR UPDATE SKIP LOCKED`, `not_before` +10 min); re-runs the gate with the UK window; allowlist mode; render; send; marketing sets `last_marketing_at` (and `last_digest_at` for digests); retries after 1/4/16/64 minutes then drops.
- `modules/email/services/events.service.ts`: webhook ingestion per the spec's table, idempotent on `sg_event_id`, events with no matching send still update the contact by address; click credit from `ik`/`cid` link parameters.
- The existing `POST /api/v1/webhooks/sendgrid` now also feeds the email event log, accepts either key name, and is mounted at `/api/webhooks/sendgrid` too.
- `modules/email/services/maintenance.service.ts`: `reconcileSuppressions` (bounces, spam reports, invalid emails, global + group unsubscribes for the last 2 days), `deliverabilityCheck` (auto-pause + `email_alerts` row + email to `EMAIL_ALERT_EMAIL`), `pruneEvents`.
- `modules/email/services/attribution.service.ts`: on `order.created` / `order.paid` → `email-order-placed`: most recent click within 5 days → `customer_orders.email_send_id` / `email_campaign_id`; last order date; +10 interest per ordered product; a contact for a customer without one (no consent).
- Jobs: `email-reconcile-suppressions` 02:15, `email-decay-interests` 03:05, `email-deliverability-check` 06:45, `email-prune-events` Sundays 04:40 (UK).
- Migration `0046_email_sending.sql`: `email_alerts`; `customer_orders.email_send_id`, `.email_campaign_id`, `.email_processed_at`.
- The LLM-drafted marketing (`modules/messaging/send.service.ts`) now also checks the email gate for an address the email system holds, so an unsubscribe or bounce there stops those drafts too.
Decisions taken:
- Bucket size = one minute of sends (hourly ÷ 60): sends are smooth (600/h = 10/min) and the runbook's "120 rows at 60/h → 60 then 60" holds exactly. A full-hour bucket would burst 60 at once.
- Rows are leased rather than held in an open transaction across the HTTP calls; a crash mid-run returns the rows after 10 minutes. The cost is a rare duplicate if a run dies after SendGrid accepted a message and before the row was marked.
- Marketing found outside the window at send time is held until the window opens; marketing found paused is re-checked every 15 minutes (pause holds mail, it does not lose it). Other gate refusals at send time drop the row with the reason.
- Webhook processing is inline (each event is one small transaction); the 2-second budget holds for SendGrid's normal batch sizes. A queue can be added if batches grow (IDEAS).
- `email-order-placed` is idempotent through `customer_orders.email_processed_at`.
- The staff alert on auto-pause uses the platform's existing internal-mail path (`integrations/sendgrid`), not the customer pipeline it reports on.
- `emit.test.ts` pins the event→queue map; its expectations were updated for the two new reactions (a changed mapping, not a loosened assertion).
- The live sandbox run against SendGrid could not be done (BLOCKERS B2).
Tests: 7 unit (payload snapshot, transport), 3 rate limiter (incl. 20 parallel takers), 7 sender (120 rows at 60/h, gate at send time, 429 retry, permanent + exhausted, allowlist, window), 15 webhook/maintenance/attribution; API suite 1247 green
Commit: (this commit)

## Section 7 — Templates and rendering — DONE 2026-11-04T20:10:00Z
Built:
- React Email (`@react-email/components` 1.0.12, React 19.2.5 pinned to the version the admin already uses) in the API; `jsx: react-jsx` in the api and worker tsconfigs.
- `modules/email/templates/layout.tsx` (header, body, footer with TBV Limited's name, company number, registered office and VAT number, the "why you got this" line, unsubscribe + preferences on marketing only), `blocks.tsx` (Hero, Text, FeaturedText (markdown), ProductGrid, BackInStockList, DealsList, OrderSummary, CartContents), `registry.tsx` (all 21 template keys with class, subject, why-line, default blocks), `render.tsx` (`renderTemplate`, `renderSend`, `renderForSamples`, `ensureTemplatesRegistered`, `tagLinks`), `links.ts` (UTM + `eid` + `ik` interest keys on shop links; product URLs; signed `cartLink`), `company.ts`, `fixtures.ts`.
- Signed add-to-cart: API `GET /api/v1/storefront/email-links/cart?t=` (storefront key) resolves the token; storefront `GET /cart/add?t=` in both shops adds the line and lands on the basket (stale link → basket with `?link=expired`). The back-in-stock email's button is now this link (IDEAS item resolved).
- Every template is registered in `email_templates` at version 1 on first render.
Decisions taken:
- React Email, as Part B #14 says (it installed cleanly).
- After rendering, the whole HTML's links are tagged once more, so links inside markdown get UTM tags and the send id too; links to other sites are untouched. Unsubscribe/preferences links carry no UTM and `clicktracking="off"` so SendGrid does not wrap them (the body never contains a sendgrid.net address of ours).
- Interest keys travel on product links as `ik=material:pla` (the click webhook credits them); `cid` is read too when a category id is present.
- The plain-text part is made from the final HTML (`toPlainText`), so it carries the same tagged links.
- Footer trader details are copied from `apps/store/lib/legal.ts` and a test fails if the two drift apart.
- Pre-order ETA change and pre-order shipping are `order_required` (the spec's class table lists "pre-order ETA change" as order-required); subscription renewal notice is `requested_service`; post-purchase tips and review request are `service`; the rest are marketing.
- First names come from a storefront user's display name, or a customer name that looks like a person's ("Ada Lovelace"), never a business name; subjects use `{{first_name|fallback}}`.
- Trade prices are not applied to deep links (BLOCKERS B3).
Tests: 133 template tests (21 templates × snapshot of subject/html/text, lint, link tagging, unsubscribe-on-marketing-only, footer, no offers in service mail; deep-link signing; first names; roll-up subject; trade price display; footer vs legal.ts; renderForSamples for every key), 5 deep-link API, 2+2 storefront `/cart/add`; API suite 1385 green; worker typechecks and boots
Commit: (this commit)

## Section 8 — Weekly digest and new-product roll-up — DONE 2026-11-04T22:30:00Z
Built:
- `modules/email/services/audience.service.ts`: segment schema (status, interests_any/all, is_trade, last_order_within/older_than_days, engaged_within_days, source, exclude_campaign_ids, contact_ids), `segmentContacts`, `buildAudience` (gate per contact, unengaged streaks in one query), `previewSegment` (count + 10 masked samples).
- `modules/email/services/campaigns.service.ts`: create / update / schedule / approve / cancel / pause / resume, approval threshold for Claude-made marketing, `expand` (rows keyed `campaign:<id>:<contact>`, `not_before` spread evenly across the window with ±10% deterministic jitter, per-contact content builders, empty content = no row), `tick` (expand due, close finished).
- `modules/email/services/digest.service.ts`: per-contact digest blocks (new in their interests since `last_digest_at`; back in stock in their interests; deals and featured paragraphs from `email_weekly_content`; shop-wide new-in + best-sellers for contacts with no interests); empty digest = no send but `last_digest_at` advances for everyone considered; `createWeeklyDigest` (once per week, scheduled for Thursday 10:00 UK, 180 minutes); new-product roll-up (24 h of new products, one email per interested contact, 48-hour digest rule, hero products set `override_gap`).
- Migration `0047_email_campaigns.sql`: `email_weekly_content`; `products.hero`.
- Jobs: `email-campaigns-tick` (every minute), `email-digest-draft` and `email-new-product-rollup` (every 15 minutes, acting once their UK day/time in settings is reached, so changing the times in settings needs no redeploy). The sender holds rows of a paused campaign and drops rows of a cancelled one.
Decisions taken:
- The digest is pre-approved (a standing campaign type) and is created as `scheduled` for Thursday; a person (or Claude) can cancel it. A digest whose scheduling failed is scheduled on the next run rather than left in draft.
- "Back in stock" in the digest = products older than a week with stock booked in this week (the platform keeps no stock-level history); requested items already got their own email.
- Deals have no table in the platform, so the digest's deals and featured copy both come from `email_weekly_content` (week, interest key or `all`), written by the operator or by Claude (section 10).
- The featured paragraph only rides along with real news: a paragraph alone is not a reason to email (the digest is a cap, not a target).
- The new-product alert uses the products' `created_at`; there is no "made purchasable" timestamp in the schema.
Tests: 6 integration (dates; full digest cycle Wednesday → Thursday → sandbox send → campaign closed; five-product roll-up with gap and hero; 48-hour skip; approval threshold 51/49 + Claude cannot approve; every segment key); API suite 1391 green
Commit: (this commit)

## Section 9 — Manual campaigns, A/B and reports — DONE 2026-11-04T23:20:00Z
Built:
- `modules/email/services/ab.service.ts`: `createVariant` (B is a second campaign row with `variant_of`, holding B's subject), `split` (audience ≥ 200: 10% A + 10% B by a stable hash, all as rows of campaign A tagged `variant`; smaller audience: A only, B closed), `decideDue` (2 hours after the first send, better unique click rate wins, tie → A, the rest get the winner), wired into the campaign tick.
- `modules/email/services/reports.service.ts`: `campaignReport` (sent, delivered, deferred, bounced, dropped by reason, unique opens/clicks, per-link clicks with tracking parameters stripped, unsubscribes within 7 days of the send, attributed orders, revenue ex/inc VAT, revenue per 1,000 sent, A/B breakdown), `automationReport`, `deliverabilityReport` (per UK day and class), `contactTimeline` (sends with events, consent changes, orders; paged), `campaignSends`.
- Migration `0048_email_report_indexes.sql`: `customer_orders(email_campaign_id)`, `customer_orders(email_send_id)`, `email_sends(kind, queued_at)`, `email_sends(sent_at)`.
- Cancelling an A/B campaign cancels its B row too.
Decisions taken:
- A/B rows all belong to campaign A (with `variant` A/B) so one report covers the test; B's row only holds B's subject.
- Opens are reported but never decide anything: the A/B winner is by clicks.
- "Unsubscribes" for a campaign = contacts who went from `all` to `transactional_only` within 7 days after being sent it (unsubscribe links are per contact, not per send).
- Report timing measured on 50,000 sends: the existing `(campaign_id, status)` index already keeps `campaignReport` well under 500 ms; the indexes above serve attribution joins, automation and deliverability reports.
Tests: 3 A/B (1,000 → 100/100/800 with B winning; tie → A; 150 → A only), 3 reports (hand-worked fixture literals; 50,000 sends < 500 ms; timeline order); API suite 1397 green
Commit: (this commit)

## Section 10 — MCP tools — DONE 2026-11-05T01:10:00Z
Built:
- An MCP server for the admin (none existed): `@modelcontextprotocol/sdk` 1.32.1, stateless Streamable HTTP at `POST /api/mcp` (`modules/email/mcp/server.ts`), authenticated by an API key with scope `email:mcp`; GET/DELETE answer 405.
- 25 tools in `modules/email/mcp/tools.ts`: the spec's set plus `email_update_campaign`, `email_pause_campaign`, `email_resume_campaign` and `email_write_weekly_content`. Descriptions state the guard rails.
- `modules/email/services/operator.service.ts`: the operations the MCP tools and the admin share (contact list/detail, consent recording, weekly content, test sends, pause/resume, deliverability summary, automations), and `audit()` → new `email_audit` table (migration `0049_email_audit.sql`), addresses masked.
- `automations` setting (every automation OFF by default, discounts off) so the automation tools have something to read and switch.
- `docs/email/MCP.md`; a test fails if its tool table and the registry differ.
- Campaign reports exclude test sends.
Decisions taken:
- Approval through MCP: the runbook's fallback ("approval is UI-only") is kept for ordinary keys, and the server's existing mechanism — API-key scopes — marks a person's key: a key with `email:approve` is recorded as `mcp:<prefix>` and may approve. Claude's keys never get that scope.
- Every MCP call is audited with actor `claude` (or `mcp:<prefix>`), success or failure.
- `email_import_csv` takes the CSV as text (saved under the evidence directory by its hash) or a path inside `imports/`; nothing outside `imports/` can be read.
- Test sends are rows of the campaign with kind `test` and `not_before` far in the future (the sender never picks them up); in sandbox or unset mode they go to SendGrid with sandbox on.
- Settings that are objects merge over their defaults, so a later default (a new automation) always has a value.
Tests: 6 (tool list vs MCP.md; descriptions; every tool called through a real MCP client with shape checks, schema refusal and audit rows; 51-contact Claude campaign → pending_approval → approved by an email:approve key; HTTP auth 401/403; initialize + tools/list over HTTP); API suite 1403 green
Commit: (this commit)

## Section 11 — Admin UI — DONE 2026-11-05T03:30:00Z
Built:
- API: `modules/email/admin/email-admin.routes.ts` (JWT): overview, contacts (filtered list, CSV export, detail with timeline, status change with reason, bulk status, re-verify, record consent), imports (CSV text upload → dry run → live run, history), segment preview, campaigns (CRUD, preview as three contacts, schedule, approve, cancel, pause, resume, test send, A/B subject), automations, templates (+ preview with sample data), weekly content, deliverability (rates, 90-day daily series, DNS, alerts, pause/resume, check DNS now), settings, audit log. Every change audited with the user as actor.
- `modules/email/services/dns.service.ts` + daily `email-dns-check` job (DNS-over-HTTPS: SPF includes SendGrid, both DKIM CNAMEs, DMARC, following a DMARC CNAME once).
- Admin SPA: "Messaging" in the sidebar (`/messaging`, hideable as `messaging`), seven pages under `apps/web/src/routes/_authed/messaging/` — Campaigns (list, approval queue, editor with block picker, live segment count, schedule/window, A/B, test send, three-contact preview in a sandboxed iframe, report), Contacts (filters, bulk status, export; detail with consent, address, interests, timeline), Imports, Automations, Templates, Deliverability (recharts line chart, pause switch, DNS, alerts), Settings. A banner on every page shows the send mode and pause state, red unless live and running. Hooks in `apps/web/src/features/email/`.
- Playwright `apps/web/e2e/messaging.spec.ts`: campaign to a 3-contact segment (preview, test send, schedule), status change with reason → consent event, import dry run, pause switch → segment count 0, and every page loading; passed against an empty database and the populated test database.
Decisions taken:
- Uploads follow the repo's existing CSV-import pattern (file read in the browser, sent as JSON text); the API keeps the text under the evidence directory by its hash, so the live run uses exactly the dry-run file.
- The segment builder offers consent, materials, trade and order/engagement windows; an exact address list (`contact_ids`) is supported by the API and MCP but not typed into the UI (the e2e sets it through the API).
- Templates are code (React Email), so the Templates page previews each with sample content and shows its registered version; campaign copy is edited per campaign.
- Native form controls rather than Radix Select inside these pages: simpler, accessible and testable.
- With no SendGrid key, a sandboxed message is accepted locally (it would never be delivered anyway); a non-sandbox send without a key still fails.
- The e2e auth helper now tolerates sandboxed iframes (it seeded the token into every frame, which threw inside the email preview).
- Playwright's Chromium path is configurable (`PLAYWRIGHT_CHROMIUM_EXECUTABLE`), defaulting to the bundled one.
Tests: 5 API admin-route integration, 2 Playwright e2e; web unit 141 green; API suite 1408 green; web `tsc -b` clean
Commit: (this commit)
