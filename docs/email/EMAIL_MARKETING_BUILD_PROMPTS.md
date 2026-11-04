# CleverDeals Email Marketing System — Claude Code build runbook

Lights-out build prompts for Claude Code (Opus 5.5). Companion to `SPEC.md` (the full specification). Written 4 November 2026.

This file is executed top to bottom by one Claude Code session (or a chain of sessions) with no human input. Every decision the spec left open is resolved below with a default, every section ends with tests and a fix loop, and anything that cannot be resolved is logged rather than asked.

---

## Part A — For Roger: how to run this

### A1. Put the files in the repo

```
docs/email/SPEC.md                      (the specification)
docs/email/EMAIL_MARKETING_BUILD_PROMPTS.md   (this file)
imports/sendgrid/bounces.csv            (SendGrid → Suppressions → Bounces → export)
imports/sendgrid/spam_reports.csv       (SendGrid → Suppressions → Spam Reports → export)
imports/sendgrid/unsubscribes.csv       (SendGrid → Suppressions → Global Unsubscribes + Group Unsubscribes, merged or two files)
imports/sendgrid/contacts.csv           (SendGrid → Marketing → Contacts → Export all)
```

Add `imports/` to `.gitignore` (the runbook will check, but do it anyway: these files contain personal data).

### A2. Set environment variables (dev `.env` and the deployment)

```
SENDGRID_API_KEY=                # scoped: Mail Send + Suppressions (read)
SENDGRID_WEBHOOK_PUBLIC_KEY=     # from Settings → Mail Settings → Event Webhook → Signed Event Webhook
BOUNCER_API_KEY=
EMAIL_FROM_ADDRESS=sales@cleverdeals.net
EMAIL_FROM_NAME=CleverDeals
EMAIL_REPLY_TO=sales@cleverdeals.net
EMAIL_SEND_MODE=sandbox          # sandbox | allowlist | live   (see A4)
EMAIL_TEST_ALLOWLIST=roger@etailsupport.com
EMAIL_TOKEN_SECRET=              # 32+ random bytes, base64; signs unsubscribe and deep-link tokens
STOREFRONT_BASE_URL=https://filament.cleverdeals.net
ADMIN_BASE_URL=https://admin.cleverdeals.net
```

### A3. SendGrid settings to make before the build reaches section 6

- Settings → Tracking: Click Tracking **on**, Open Tracking **on**, Subscription Tracking **off**.
- Settings → Mail Settings → Event Webhook: add an endpoint `https://admin.cleverdeals.net/api/webhooks/sendgrid`, enable **Signed Event Webhook**, select all delivery and engagement events. If this SendGrid account is shared with Beagle, add it as a second endpoint; do not replace Beagle's.
- Settings → Sender Authentication: confirm the domain `cleverdeals.net` shows Verified and check whether Link Branding is set up (spec, Deliverability section).
- DNS: replace the SPF record with `v=spf1 include:_spf.google.com include:sendgrid.net ~all` (optional, spec explains why).

### A4. Send modes, so nothing goes out by accident

| `EMAIL_SEND_MODE` | What the sender does |
| --- | --- |
| `sandbox` (default during the build) | Calls SendGrid with `mail_settings.sandbox_mode.enable = true`. SendGrid validates and returns 200 but delivers nothing. Everything else (queueing, logging, webhooks via the test harness) behaves as production. |
| `allowlist` | Real sends, but only to addresses in `EMAIL_TEST_ALLOWLIST`. Any other recipient is logged as `dropped` with reason `not_in_allowlist`. Use this for the two-week parallel run with your own address first. |
| `live` | Real sends to everyone the gate allows. Set only by you, after the handover report. |

The build never sets `live`. Section 14 tells you what to check before you do.

### A5. Start the run

Open Claude Code at the repository root and paste the **Kickoff prompt** (Part C) exactly. It instructs the session to read this file and execute Parts D and E in order. If the session hits its context limit, start a new session and paste the kickoff prompt again: the runbook is resumable — each section checks `docs/email/BUILD_LOG.md` and skips sections already marked done.

What you get back: one git commit per section on branch `feature/email-marketing`, `docs/email/BUILD_LOG.md` (what was built and tested, per section), `docs/email/BLOCKERS.md` (anything the session could not resolve and what it did instead), `docs/email/HANDOVER.md` (what to check and the steps to go live).

---

## Part B — Decisions resolved for lights-out execution

These replace the "Decisions needed" list at the end of `SPEC.md`. Claude Code applies them without asking. Change any of them here before starting the run if you disagree.

| # | Decision | Default applied |
| --- | --- | --- |
| 1 | Contacts table vs fields on customers | **Separate `email_contacts` table**, linked from `customers.contact_id`. Imported unsubscribes are contacts only. |
| 2 | Never Email definition | Order-required emails still go (order confirmation, payment, dispatch, delivery, refund, pre-order ETA change, bank-transfer instructions, password reset). Everything else stops. |
| 3 | Weekly digest | **A cap, not a target.** Empty digest = no send. |
| 4 | Digest schedule | Draft created Wednesday 10:00 Europe/London; sends Thursday 10:00 over a 180-minute window. |
| 5 | Discount policy | **Off** for every automation by default. Each automation has a `discount_allowed` toggle and `discount_code` field in settings; nothing is populated. |
| 6 | Replenishment defaults (days to empty, 1 kg spool) | PLA 42, PETG 49, ABS/ASA 56, TPU 70, Nylon 70, Carbon-fibre blends 56, anything else 49. Multiply by quantity ordered. Stored as editable settings. |
| 7 | Approval threshold for Claude-initiated marketing sends | 50 contacts. |
| 8 | SendGrid account | Assume **shared with Beagle**. Build the webhook as a new endpoint; never modify Beagle's code or settings. The API key is a new, separately scoped key read from `SENDGRID_API_KEY` in this app's env. |
| 9 | Interest population on import | Read a `lists` or `list_names` column if the contacts export has one and map list names to categories by case-insensitive substring match on material names (PLA, PETG, ABS, ASA, TPU, Nylon, Carbon, Silk, Wood). Rows with no match get the upload's default interests. For the lights-out run the default interests are **all top-level material categories** at score 3 (the "interested" threshold), so nobody is excluded from the first digest. |
| 10 | Abandoned cart email capture | If checkout does not already store the email before payment, add it (capture on blur of the email field via a `POST /api/cart/email` endpoint, stored on the cart row). |
| 11 | Trade flag source | Derive `is_trade` from the existing trade-discount tier on the customer; if no such attribute exists, from "any order with quantity ≥ 10 of one SKU". Log which rule was used. |
| 12 | SPF / link branding | Not touched by code. Section 14 reports them in the handover. |
| 13 | Phase order | UI (section 11) before automations (section 12), as in the spec. |
| 14 | Template engine | **React Email** (`@react-email/components`) rendered server-side to HTML + plain text, because the stack is Next.js/TypeScript. If React Email cannot be installed, fall back to MJML; log the choice. |
| 15 | Test framework | Whatever the repo already uses. If none: Vitest for unit, Vitest + a test Postgres database for integration, Playwright for the two public pages. |
| 16 | Interest decay | Score halves every 180 days; order/pre-order/subscription/back-in-stock request +10; email click +2; "interested" = score ≥ 3. |
| 17 | Marketing rate limit | 600 sends per hour, token bucket refilled per minute; configurable in settings. |
| 18 | Auto-pause thresholds | Marketing pauses itself at 7-day complaint rate ≥ 0.2% or bounce rate ≥ 3% (minimum 200 sends before the rate counts). |
| 19 | Event retention | `email_events` rows older than 13 months are deleted by a weekly job. |
| 20 | Attribution window | An order is attributed to the most recent campaign the contact clicked within the previous 5 days. |

---

## Part C — Kickoff prompt (paste this into Claude Code)

```
You are building the CleverDeals email marketing system inside this repository, working alone with no human available to answer questions.

Read these two files completely before doing anything else:
- docs/email/SPEC.md — the specification
- docs/email/EMAIL_MARKETING_BUILD_PROMPTS.md — the runbook you are executing

Then execute Part D (global rules) and Part E (sections 0 to 14) of the runbook in order, one section at a time, from start to finish. Do not stop between sections to ask whether to continue. Do not ask any questions at any point; where something is ambiguous, apply the defaults in Part B, otherwise choose the option that is safest for the recipients and the data, record the choice in docs/email/BUILD_LOG.md, and carry on.

Before starting, read docs/email/BUILD_LOG.md if it exists. Skip any section it marks as "DONE" and resume at the first section not marked done.

Finish by writing docs/email/HANDOVER.md as described in section 14.
```

---

## Part D — Global rules (apply to every section)

D1. **No questions, no pauses.** Decide, log, continue. The log entry format is in D8.

D2. **Branch and commits.** Work on `feature/email-marketing` (create from the default branch if absent). One commit at the end of each section, message `email: section N — <title>`, plus intermediate commits whenever a test suite goes green after being red. Never force-push, never rebase, never touch other branches.

D3. **Nothing sends for real.** `EMAIL_SEND_MODE` stays `sandbox` throughout the build; the code must refuse to run the sender if the variable is unset. Never write `live` into any env file, fixture or default. Never call the real Bouncer API in tests; use recorded fixtures.

D4. **Do not break what exists.** Additive migrations only — no column drops, no renames, no type changes on existing tables. Never run, edit or import `scripts/seed-storefront.ts` or any seed script that writes product, stock or category data. The existing back-in-stock feature must behave identically to users after section 3; if an existing test covers it, that test must still pass unchanged.

D5. **Follow the repository's conventions**, discovered in section 0 and written to `docs/email/CONTEXT.md`: directory layout, ORM/query style, job definitions, API route shape, auth guards, admin UI components, lint and format settings, MCP tool registration. When this runbook and the repo's conventions disagree on style, the repo wins; when they disagree on behaviour, this runbook wins.

D6. **Testing per section.** Every section ends with: `typecheck → lint → unit tests → integration tests → (where listed) Playwright`. All must pass. If anything fails, fix it and rerun. After three full fix attempts on the same failure, mark the test `skip` with a comment `// BLOCKED: see docs/email/BLOCKERS.md#<id>`, write the blocker, and continue to the next section. Never delete a failing test, never loosen an assertion to make it pass, never mark a section DONE with unlogged failures.

D7. **Test infrastructure.** Section 0 establishes a test Postgres (reuse the repo's if present; otherwise a `docker compose` service named `email-test-db`, or `pg-mem` if Docker is unavailable, logging which). External HTTP (SendGrid, Bouncer) is intercepted with `msw` or `nock` and recorded fixtures under `tests/fixtures/email/`. Time is controlled with fake timers in any test involving schedules, gaps or decay.

D8. **Logging.** Append to `docs/email/BUILD_LOG.md` at the end of each section:

```
## Section N — <title> — DONE <ISO timestamp>
Built: <bullets, file paths>
Decisions taken: <bullets, or "none">
Tests: <n unit, n integration, n e2e; all green | n skipped (BLOCKERS #id)>
Commit: <sha>
```

`docs/email/BLOCKERS.md` gets one entry per unresolved item: id, section, what was attempted, what was done instead, what Roger needs to do.

D9. **Secrets and data.** Never print an API key, token secret or a full email address from the import files into logs, tests or commits. Fixtures use `@example.com` addresses. `imports/` must be in `.gitignore`; section 0 checks.

D10. **Scope discipline.** Build what the section says. Improvements outside the section go in `docs/email/IDEAS.md`, not in the code.

D11. **Resumability.** Each section starts by checking BUILD_LOG for its own DONE marker and, if present, skips to the next. Migrations are idempotent (the migration tool handles this; do not hand-write guards).

---

## Part E — Sections

Each section has: Goal, Build, Tests, Done when, Commit. "Spec §" refers to headings in `docs/email/SPEC.md`.

---

### Section 0 — Discovery and preparation

**Goal.** Know the codebase well enough to build on it without guessing, and set up the test harness.

**Build.**

1. Survey the repository and write `docs/email/CONTEXT.md` recording, with file paths:
   - Framework and versions (Next.js App Router version, TypeScript, Node), package manager, lint/format tools, test runner if any.
   - Database access: ORM or query builder, migration tool and command, where migrations live, naming convention, how enums are declared.
   - Existing tables and columns for: customers, orders, order lines, products, variants, categories, carts, back-in-stock requests, pre-orders, subscriptions, trade/discount tiers, admin users.
   - The existing back-in-stock sender: where it is, how it calls SendGrid, what template it uses, what triggers it.
   - Any existing SendGrid client, email templates, or transactional sends (order confirmation etc.) and where they are called from.
   - pg-boss: how jobs are defined, registered, scheduled (cron), and where the worker runs.
   - Admin app: layout, navigation registration, auth guard, table/list components, form components, how pages are added.
   - MCP server: where tools are registered, the schema style, how auth/actor is passed, an example tool to copy.
   - Settings storage: how app settings are stored and edited (key-value table, JSON column, env only).
   - Storefront: checkout email capture, newsletter signup form, footer form, where the header component lives for the public pages.
   - Env handling: how env vars are validated/loaded.
2. Confirm `imports/` is git-ignored; add it if not. Confirm the four import files exist and record their row counts and column headers (headers only, no data) in CONTEXT.md. If a file is missing, record it; section 4 will handle absence.
3. Set up the test harness per D7: test database, `msw`/`nock`, fake timers, fixtures directory, an `npm run test:email` script that runs only this module's tests, and make sure the repo's full test command still works.
4. Add the env variables from Part A2 to the env validation layer with `EMAIL_SEND_MODE` defaulting to `sandbox` and refusing unknown values. Add them to `.env.example` with empty values.
5. Create the module skeleton at `src/modules/email/` (or the repo's equivalent of a module folder): `README.md` pointing at SPEC.md, and empty `services/`, `jobs/`, `templates/`, `mcp/`, `admin/`, `public/`, `lib/` folders (or the names the repo convention dictates — record the mapping in CONTEXT.md).

**Tests.** The harness runs a trivial passing test against the test database and a trivial intercepted HTTP call. Repo-wide test command still green.

**Done when.** CONTEXT.md answers every bullet above (write "not found" where applicable), harness green, env validated.

**Commit.** `email: section 0 — discovery and test harness`

---

### Section 1 — Schema, consent log and the gate

**Goal.** The data model from Spec § Data model and the single `canSend()` gate from Spec § Email classes and consent rules.

**Build.**

1. Migration(s) creating:
   - `email_contacts` with every column listed in Spec § Data model. `email` unique, lower-cased and trimmed (enforce with a check constraint or a generated column; also normalise in code). `marketing_status` enum `all | transactional_only | never`. `deliverability` enum `ok | soft_bounce | hard_bounce | complained | invalid`. `unsubscribe_token` = 32 random bytes base64url, unique, generated on insert. `interests` jsonb default `{}`.
   - `email_consent_events` (append-only: no update/delete grants to the app role if roles are used; otherwise a trigger that raises on UPDATE/DELETE).
   - A trigger on `email_contacts` that raises unless the new `marketing_status` matches the latest `email_consent_events` row for that contact written in the same transaction (implement as: the service writes the consent event first, then updates the contact; the trigger checks the latest event's `to_status` equals the new value and its `created_at` is within the current transaction's timestamp). Record the exact mechanism in CONTEXT.md.
   - `email_campaigns`, `email_sends`, `email_events`, `email_templates`, `email_imports` with the columns in Spec § Data model. `email_sends.idempotency_key` unique. `email_events.sg_event_id` unique.
   - `customers.contact_id` nullable FK → `email_contacts.id`.
   - `email_settings` key-value store (or the repo's existing settings mechanism) seeded with every default from Part B and Spec: rate limit 600/h, gap days 7, approval threshold 50, send window 08:00–20:00 Europe/London, digest day/time, window minutes 180, auto-pause thresholds, interest decay parameters, replenishment defaults per material, discount toggles off, test allowlist from env.
2. Backfill: a migration or one-off script `scripts/email/backfill-contacts.ts` that creates an `email_contacts` row for every existing customer with an email (status `all` only where the existing customer record carries evidence of marketing consent — a newsletter flag, an opt-in column; otherwise `transactional_only`), sets `customers.contact_id`, writes a consent event with source `backfill`, and populates `interests` from the customer's order history (categories of ordered products, +10 each, decayed from order date), `last_order_at`, and `is_trade` per Part B #11. Idempotent; logs counts.
3. Service `contacts.service.ts`: `findOrCreateByEmail(email, {customerId?, source, evidence})`, `setMarketingStatus(contactId, to, {source, actor, reason?, ip?, userAgent?, confirm?})` enforcing the transition rules in Spec § Email classes (upgrades to `all` need `source` of a person-submitted form or an admin/MCP call with `confirm: true`; nothing leaves `never` except admin/MCP with `confirm: true`), `recordDeliverability(contactId, event)`, `addInterest(contactId, categoryId, points)`, `decayInterests()` (nightly), `isInterested(contact, categoryId)`.
4. `gate.ts`: `canSend(contact, { class, kind, now }): { ok: true } | { ok: false, reason }` implementing the class table and every bullet under "Additional gates for the marketing class" in Spec § Email classes. The class table is data (a const map), not a chain of ifs. Reasons are an enum: `never`, `transactional_only`, `hard_bounce`, `complained`, `invalid`, `soft_bounce_limit`, `gap`, `window`, `unengaged`, `paused`, `allowlist`.
5. A kill switch `email_settings.marketing_paused` checked by the gate for class `marketing`.

**Tests.**
- Unit: a table-driven test covering every cell of the class × status × deliverability matrix in Spec § Email classes (4 classes × 3 statuses × 5 deliverability values = 60 cases, plus the gap, window, soft-bounce-limit, unengaged and paused cases with fake timers).
- Unit: every row of the status-transitions table; forbidden transitions throw; every allowed transition writes exactly one consent event.
- Integration: the trigger refuses a direct `UPDATE email_contacts SET marketing_status` without a consent event; the service path succeeds.
- Integration: backfill on a fixture of 20 customers (5 with orders, 2 trade, 3 with an opt-in flag) produces the expected contacts, statuses, interests and `contact_id` links; running it twice changes nothing.
- Unit: email normalisation (`" Foo@Example.COM "` → `foo@example.com`, `<a@b.c>` and `mailto:` stripped, no Gmail dot folding).

**Done when.** Migrations apply cleanly to a fresh test database and to a copy of the dev database; all tests green.

**Commit.** `email: section 1 — schema, consent log and gate`

---

### Section 2 — Unsubscribe and preferences pages

**Goal.** Spec § Sending pipeline → "Unsubscribe endpoints", built before anything can send.

**Build.**

1. Token helper `lib/tokens.ts`: `unsubscribeToken(contact)` returns the stored `unsubscribe_token`; `signedLink(payload, ttl?)` / `verifySignedLink(token)` using HMAC-SHA256 with `EMAIL_TOKEN_SECRET` (used later for add-to-cart deep links). Constant-time compare.
2. Storefront routes (public, no auth, no CSRF requirement on the one-click POST, rate-limited 30/min per IP):
   - `POST /email/u/[token]` — accepts `application/x-www-form-urlencoded` body `List-Unsubscribe=One-Click`; sets `transactional_only` with source `one_click`; returns 200 with an empty body. Idempotent. Unknown token → 200 as well (do not leak which tokens exist), logged.
   - `GET /email/u/[token]` — server-rendered page with the store header: "Unsubscribe <masked email> from marketing emails?" and one button that POSTs to the same URL with a form field `confirm=1` (distinguish from one-click by the body). After confirming: a page saying what they will still receive (order and requested emails) and a link to preferences.
   - `GET /email/preferences/[token]` and `POST` — tick boxes: interests (one per top-level material category), weekly digest on/off, new-product alerts on/off, "unsubscribe from all marketing". Saves via the contacts service with source `preferences_page`; ticking "all marketing" back on from `transactional_only` is allowed (person-submitted form), from `never` is not shown.
   - Both pages: `noindex`, no analytics scripts, work without JavaScript, mobile layout, English only.
3. Contact fields used by the preferences page: add `digest_enabled` bool default true and `new_product_alerts_enabled` bool default true to `email_contacts` (additive migration). The gate treats `digest_enabled=false` as a reason for kind `weekly_digest` only, and likewise for `new_product`.
4. Header builder `lib/headers.ts`: `marketingHeaders(contact)` returns `List-Unsubscribe` (both the https and mailto forms; the mailto address is `unsubscribe@cleverdeals.net` with the token as subject) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Used by section 6.

**Tests.**
- Integration: one-click POST flips status, writes a consent event with source `one_click` and the IP, returns 200, and a second POST is a no-op; wrong token returns 200 and writes nothing.
- Integration: GET page renders; POST with `confirm=1` flips status; `never` contacts see "you are already unsubscribed" and no button.
- Integration: preferences round trip; unticking everything equals unsubscribe; re-ticking from `transactional_only` upgrades with source `preferences_page`.
- Playwright: both pages at 375 px wide — no horizontal scroll, button reachable, works with JavaScript disabled.
- Unit: header builder output matches RFC 8058 exactly (two angle-bracketed URIs, comma-separated; the POST header value verbatim).

**Done when.** `curl -X POST -d 'List-Unsubscribe=One-Click' <dev url>/email/u/<token>` returns 200 and the contact is `transactional_only`.

**Commit.** `email: section 2 — unsubscribe and preferences pages`

---

### Section 3 — Move back-in-stock onto the gate

**Goal.** The existing back-in-stock sender becomes the first client of the shared pipeline without changing what customers receive (Spec § Campaign types → Back in stock).

**Build.**

1. Introduce `sends.service.ts` with `enqueueSend({ contactId, class, kind, templateKey, data, campaignId?, idempotencyKey })` which: runs `canSend`, writes an `email_sends` row (`queued`, or `dropped` with the gate reason if refused), and publishes a pg-boss `email.send` job (the job handler is section 6; until then, a stub handler marks the row `sent` in sandbox mode so this section is testable end to end).
2. Replace the back-in-stock feature's direct SendGrid call with `enqueueSend(class: 'transactional', kind: 'back_in_stock', idempotencyKey: 'bis:<requestId>')`. Keep the existing template content for now; register it as an `email_templates` row with key `back_in_stock` and version 1 (rendering engine arrives in section 7; until then the existing template path is used by the stub).
3. Rules from the spec: one email per request; stock crossing 0 → ≥1 triggers; a second crossing within 24 hours does not re-send; request closes on send or at 180 days; multiple open requests for the same contact that come back on the same day are rolled into one email (a daily 09:00 Europe/London `email.bis-rollup` job collects requests fulfilled since the last run per contact and sends one email listing all; immediate sends are kept for the single-request case — implement as: on stock crossing, if the contact has other open requests fulfilled in the last 60 minutes, defer to the roll-up; else send now).
4. Ensure the request records `contact_id` (additive column) and creates the contact via `findOrCreateByEmail` with source `back_in_stock_form`, `+10` interest for the product's category.
5. The deep link in the email is a signed add-to-cart link to the exact variant (route built in section 9; for now emit the product URL and leave a `TODO(section 9)` marker that section 9 must resolve — add it to IDEAS.md as a tracked item, not a silent TODO).

**Tests.**
- Existing back-in-stock tests still pass unchanged.
- Integration: stock 0→1 creates a `queued` send with class `transactional`; a `never` contact gets `dropped` with reason `never`; a `transactional_only` contact still gets it; a `hard_bounce` contact does not.
- Integration: two crossings within 24 hours produce one send; two requests fulfilled within 60 minutes produce one roll-up send listing both.
- Integration: a request older than 180 days is closed by the nightly job without sending.

**Done when.** The back-in-stock path has no direct SendGrid call left (grep confirms) and all tests pass.

**Commit.** `email: section 3 — back-in-stock through the gate`

---

### Section 4 — CSV importer

**Goal.** Spec § CSV import, run against the real exports on the dev database.

**Build.**

1. `imports.service.ts` with `runImport({ filePath, listType, defaultStatus, defaultInterests, consentSource, dryRun, actor })`. `listType` ∈ `bounces | spam_reports | unsubscribes | contacts`. Streaming CSV parse (`csv-parse` or the repo's choice), batch writes of 500, idempotent on `(import_id, row_number)` and on content hash of the file (re-running the same file is a no-op with a report saying so).
2. Column detection per list type: find the email column by header (`email`, `EMAIL`, `email_address`, `Email Address`); created-at by header (`created_at`, `created`, `Created At`, `date_added`); list membership by header (`lists`, `list_names`, `LIST_IDS` — resolve ids to names only if a names column exists; otherwise ignore). Log the mapping used. Unknown layout → record every header in the report and stop that import with a blocker, do not guess.
3. Rules exactly as Spec § CSV import: most-restrictive-wins; imports never upgrade; `never` never changes; existing customer matched by email links rather than duplicating; `consent_evidence` = `{ import_id, row, filename, sha256 }`; the file is copied to the evidence store (reuse the repo's object store if one exists; otherwise `var/email-evidence/` git-ignored) with its hash.
4. Interest mapping per Part B #9.
5. Dry-run report shape (JSON, also rendered as a markdown table in the log): `rows_read, valid, invalid_syntax, duplicates_in_file, already_present, would_create, would_update, would_downgrade, would_upgrade_refused, conflicts[] (first 50)`. The live run requires a `dryRunId` whose file hash matches.
6. CLI `scripts/email/import.ts --type <t> --file <p> [--live --dry-run-id <id>]` for Roger's production run, and the service is also what the MCP tool and the UI call later.
7. Run all four imports **as dry runs** against the dev database in the order bounces → spam_reports → unsubscribes → contacts and record the reports in BUILD_LOG (counts only). Then run them **live on the dev database** in the same order and record the resulting status distribution. If a file is missing, log it in BLOCKERS and continue with the ones present.

**Tests.**
- Unit: header detection on six synthetic layouts (SendGrid's current contacts export header set, the suppressions export set, a bare `email` column, a layout with `lists`, a layout with a BOM, a layout with CRLF).
- Integration: the four-file sequence on fixtures where one address appears in all four → ends `hard_bounce` + `transactional_only`; one in unsubscribes and contacts → `transactional_only`; one only in contacts → `all` with `consent_at` from the file; one matching an existing `never` contact → unchanged; one matching an existing customer → linked, no duplicate.
- Integration: re-running a file is a no-op; running live with a stale dry-run id is refused.
- Unit: interest mapping from list names.

**Done when.** Dev database holds the imported contacts with the distribution logged; all tests green.

**Commit.** `email: section 4 — CSV importer`

---

### Section 5 — Bouncer verification

**Goal.** Spec § Address verification with Bouncer.

**Build.**

1. `lib/bouncer.ts` client: `verify(email)` → `{ status: 'deliverable'|'undeliverable'|'risky'|'unknown', reason, raw }` and `verifyBatch(emails[])` using Bouncer's batch endpoint with polling. Timeouts 10 s single, batch polled every 30 s up to 2 h. Secrets from env; never logged.
2. pg-boss job `email.verify` (singleton per contact id, retry 3 with backoff) enqueued from `findOrCreateByEmail` for sources `checkout`, `signup_form`, `back_in_stock_form`, `pre_order`, `subscription`; never for `sendgrid_import`, `backfill`, `admin`, `mcp`. Skip when `bouncer_checked_at` is within 90 days.
3. Result handling exactly as Spec § Bouncer: `undeliverable` → `invalid`; `risky` → stored, first soft bounce escalates straight to `hard_bounce`; `unknown` → one retry at 24 h then treated as risky.
4. `reverifyDormant({ olderThanDays: 365 })` service used by win-back (section 12): batch verifies and waits.
5. Never block a request path: the verify is enqueued after the contact row commits.

**Tests.**
- Unit: client against recorded fixtures for each status, a timeout, a 429, a 500.
- Integration: contact created from checkout enqueues a verify job; from import does not; a contact verified 30 days ago is skipped; `undeliverable` sets `invalid` and the gate then refuses marketing but allows order-required.
- Integration: a `risky` contact that soft-bounces once becomes `hard_bounce`.

**Done when.** All green; no real Bouncer call appears in test output (assert the interceptor saw every request).

**Commit.** `email: section 5 — Bouncer verification`

---

### Section 6 — Sender job, SendGrid client, event webhook

**Goal.** Spec § Sending pipeline, minus templates (section 7).

**Build.**

1. `lib/sendgrid.ts`: `send(message)` posting to `/v3/mail/send` with `personalizations`, `from`, `reply_to`, `subject`, `content` (text + html), `custom_args` (`send_id, campaign_id, contact_id, class, kind`), `categories` (`[class, kind]`), `headers` (marketing headers for class `marketing`), `tracking_settings` (click + open on, subscription tracking off explicitly), and `mail_settings.sandbox_mode` per `EMAIL_SEND_MODE`. In `allowlist` mode, recipients outside `EMAIL_TEST_ALLOWLIST` are not sent and the send row is `dropped` with `not_in_allowlist`. Returns the `X-Message-Id` header. Maps 429 and 5xx to a retryable error, other 4xx to a permanent error with the response body.
2. Rate limiter `lib/rate-limit.ts`: a token bucket row in `email_rate_limit` (or a settings row) with capacity = hourly limit, refilled per minute; `take(n)` is atomic (`UPDATE … RETURNING` or advisory lock). Requested-service sends take tokens too; only the send window is bypassed for them.
3. pg-boss `email.send` handler (replacing the section 3 stub): batch of up to 50 `queued` rows (`FOR UPDATE SKIP LOCKED`), re-run `canSend` per row at send time, render (section 7; until then use the existing template path), call `send`, update the row to `sent` with `sendgrid_message_id` and `sent_at`; on retryable error reschedule with backoff 1/4/16/64 minutes then `dropped`; on permanent error `dropped` with the body. `send_window_minutes` on a campaign spreads its rows' `not_before` timestamps evenly with ±10% jitter at expansion time (section 8); the handler respects `not_before`.
4. Scheduler: a pg-boss cron every minute runs `email.send` if tokens are available and queued rows exist; workers are idempotent on `idempotency_key`.
5. Webhook `POST /api/webhooks/sendgrid`: verify the ECDSA signature against `SENDGRID_WEBHOOK_PUBLIC_KEY` using the `X-Twilio-Email-Event-Webhook-Signature` and `-Timestamp` headers (copy the approach from Beagle's handler if its code is reachable in this environment; otherwise implement per SendGrid's docs with the `@sendgrid/eventwebhook` package). Insert each event into `email_events` on `sg_event_id` (ignore duplicates), find the send by `custom_args.send_id`, and apply the table in Spec § Sending pipeline → Webhook, including the consent event for `spamreport` and the interest +2 on `click` (resolve the clicked URL to a product category via the UTM/`eid` parameter added in section 7). Unknown send ids are stored and logged, not rejected. Respond 200 within 2 s; do the processing in a pg-boss `email.events` job if it cannot be done inline fast enough.
6. Nightly jobs: `email.reconcile-suppressions` (pull SendGrid bounces, spam reports, global and group unsubscribes via the API, apply to any contact not already marked); `email.deliverability-check` (7-day rates by class; auto-pause marketing per Part B #18 and write an admin notification row — reuse the repo's notification mechanism if any, else a `email_alerts` table); `email.decay-interests`; `email.close-stale-bis`; weekly `email.prune-events`.
7. Attribution hook: on order creation, find the contact's most recent `clicked` send within 5 days and store `orders.email_campaign_id` / `orders.email_send_id` (additive columns).

**Tests.**
- Unit: SendGrid payload builder snapshot for a marketing send and a transactional send (headers present/absent, categories, sandbox flag per mode, allowlist drop).
- Unit: rate limiter under concurrency (20 parallel takers, exact token accounting with fake timers).
- Integration: 120 queued rows with a 60/hour limit → 60 sent in the first hour, 60 in the second (fake timers); a row refused by the gate at send time is `dropped`, not sent; a 429 then a 200 results in one send and one retry record.
- Integration: webhook with a correctly signed fixture for each event type applies the right transition; a bad signature is 401 and writes nothing; a duplicate `sg_event_id` is ignored; `spamreport` writes a consent event with source `complaint_webhook`.
- Integration: reconciliation applies a SendGrid suppression the webhook missed; deliverability-check pauses marketing at 0.2% complaints over 200+ sends and does nothing under 200 sends.
- Integration: an order placed 3 days after a click is attributed; 6 days after is not.

**Done when.** A sandbox-mode run of 50 sends from the dev database shows 50 `sent` rows with message ids (sandbox returns them) and the webhook fixture replay updates them to `delivered`.

**Commit.** `email: section 6 — sender, SendGrid client and webhook`

---

### Section 7 — Templates and rendering

**Goal.** Spec § Sending pipeline (tracking, UTM, deep links) and the content-block renderer every campaign uses.

**Build.**

1. React Email (Part B #14) base layout: header with logo and store name, body slot, footer with the registered company name, address, Companies House number (read from the storefront's existing Organization/config data — do not invent), "why you got this" line, unsubscribe link (`/email/u/<token>`) and preferences link on marketing only; plain-text alternative generated from the same tree.
2. Block renderer `templates/blocks/`: `ProductGrid` (products with image, name, price in GBP, trade price if `is_trade`, button → deep link), `BackInStockList`, `DealsList`, `FeaturedText` (markdown → HTML), `OrderSummary`, `CartContents`, `Hero`. Each block takes typed props; a campaign's `content` jsonb is an ordered array of `{ type, props }`.
3. Templates registered in `email_templates` with keys: `back_in_stock` (replace the legacy one; same information, new layout), `weekly_digest`, `new_product_alert`, `manual`, `welcome_1/2/3`, `abandoned_cart_1/2/3`, `replenishment_1/2`, `post_purchase_tips`, `review_request`, `winback_1/2`, `preorder_eta`, `preorder_shipping`, `subscription_renewal`, `subscription_add`, `price_drop`. Automations in section 12 only fill content; the templates exist now so section 8–12 can test rendering.
4. Links: every `<a href>` to the storefront gets `utm_source=email&utm_medium=<class>&utm_campaign=<campaign id or kind>&eid=<send id>`; product links also carry `cid=<category id>` so the click webhook can credit interest. Signed add-to-cart deep link route `GET /cart/add?sku=…&qty=…&t=<signed>` on the storefront: verifies the token, adds the variant to a fresh or existing cart, applies trade pricing for the contact's customer if linked, redirects to the cart. No account access is granted. Resolve the section 3 IDEAS item.
5. `render(templateKey, data, contact)` → `{ subject, html, text }` with subject templates supporting `{{first_name}}` fallbacks; preview helper `renderForSamples(campaign, n=3)` picking three real contacts (one with interests, one trade, one new) — used by the UI and MCP.
6. Rendered HTML must pass a basic lint: no external CSS, inline styles, images with alt text, width ≤ 600 px, total size < 100 KB (Gmail clipping), and no `sendgrid.net` string anywhere in the body.

**Tests.**
- Snapshot per template with fixture data (html and text).
- Unit: UTM and `eid`/`cid` present on every storefront link; unsubscribe link only on marketing; footer company details match config.
- Integration: deep link adds the right variant and quantity, applies trade price for a trade contact, rejects a tampered token, expires after 30 days.
- Unit: the HTML lint rules on every template.

**Done when.** `renderForSamples` returns three previews for every template key without error.

**Commit.** `email: section 7 — templates and rendering`

---

### Section 8 — Weekly digest and new-product roll-up

**Goal.** Spec § Campaign types → Weekly digest and New-product alert.

**Build.**

1. `audience.service.ts`: `buildAudience(segment)` → contact ids after the gate, with `previewSegment(segment)` returning count + 10 samples. Segment definition jsonb: `{ status?, interests_any?, interests_all?, is_trade?, last_order_within_days?, last_order_older_than_days?, engaged_within_days?, source?, exclude_campaign_ids?, contact_ids? }`.
2. `campaigns.service.ts`: create/update/schedule/approve/cancel/pause/resume; `expand(campaignId)` writes `email_sends` rows with `not_before` spread across the window; approval threshold logic (Part B #7) applies when the creating actor is `claude`; status machine as in Spec § Data model.
3. Digest builder `digest.service.ts`: per contact, assemble blocks in the spec's order from products created/made-purchasable since `last_digest_at` (new contact column, additive), back-in-stock crossings in their categories, active deals, the week's featured text per material (an `email_weekly_content` table row per material per week, written by the MCP tool in section 10 or by the UI; absent → block omitted), store-wide fallback for contacts with no interests. Empty digest → no send row, and `last_digest_at` is still advanced.
4. Jobs: Wednesday 10:00 Europe/London `email.digest-draft` creates the campaign in `draft` with audience count and three previews, status `scheduled` for Thursday 10:00 with a 180-minute window (it is pre-approved because it is a standing campaign type, not a Claude-initiated one; the UI/MCP can cancel it). Thursday the sender picks it up.
5. New-product roll-up: daily 11:00 `email.new-product-rollup` collects products added in 24 h, groups by category, creates one `new_product` campaign per run whose per-contact content is filtered to their interests, skipping contacts inside the 7-day gap or whose digest is due within 48 hours, and honouring `new_product_alerts_enabled`. `products.hero` flag (additive column) with `override_gap` on the campaign.
6. The gate's gap rule uses `last_marketing_at`, which the sender sets on every marketing send.

**Tests.**
- Integration with fake timers: a fixture week — 3 new PLA products, 1 PETG back in stock, 1 deal — produces digests only for contacts interested in PLA/PETG or with no interests; a contact with nothing relevant gets no send and `last_digest_at` advances; the campaign expands to rows spread over 180 minutes.
- Integration: five products added on one day → one new_product send per interested contact; a contact mailed 3 days ago is skipped; a hero product with `override_gap` is not.
- Integration: a Claude-created manual campaign to 51 contacts goes to `pending_approval`; to 49 goes to `scheduled`.
- Unit: segment builder for each key; `exclude_campaign_ids` excludes anyone with a send in those campaigns.

**Done when.** A full digest cycle (Wednesday draft → Thursday send in sandbox mode) runs end to end in a test with fake timers.

**Commit.** `email: section 8 — weekly digest and new-product roll-up`

---

### Section 9 — Manual campaigns, A/B and reports

**Goal.** Spec § Campaign types → Manual campaign; the reporting queries everything else reads.

**Build.**

1. A/B: `variant_of` on a campaign; `expand` sends variant A and B to 10% each (random, stable by contact id hash), schedules `email.ab-decide` 2 hours after the first send to pick the winner by click rate (ties → A) and expands the remaining 80% under the winner. Minimum 200 total audience for A/B; below that, A only, logged.
2. `reports.service.ts`: `campaignReport(id)` → sent, delivered, deferred, bounced, dropped (by reason), opened (unique), clicked (unique), per-link clicks, unsubscribes, complaints, attributed orders, attributed revenue (sum of order totals ex-VAT and inc-VAT), revenue per 1,000 sent, A/B breakdown. `automationReport(kind, days)` and `deliverabilityReport(days)` (rates by class per day). All pure SQL/ORM, no per-row loops.
3. Contact timeline query: sends with their events, consent events, orders, interleaved and paged.

**Tests.**
- Integration: A/B on 1,000 fixture contacts → 100/100 then 800 to the winner; a 150-contact audience sends A only.
- Integration: report numbers on a seeded fixture of sends/events/orders match hand-computed expectations (write the expectations as literals in the test).

**Done when.** Reports return in under 500 ms on a fixture of 50,000 sends (add indexes until they do; record which).

**Commit.** `email: section 9 — manual campaigns, A/B and reports`

---

### Section 10 — MCP tools

**Goal.** Spec § MCP interface, every tool, registered in the existing MCP server.

**Build.**

1. Register every tool in Spec § MCP interface with the `email_` prefix, following the schema and registration style found in section 0. Every tool call writes an audit row (`email_audit`: tool, actor, args with addresses masked, result summary, timestamp). Actor is `claude` unless the MCP session identifies Roger (use the server's existing mechanism; if none, treat every MCP call as `claude`, and `email_approve_campaign` then refuses with a message that approval is UI-only — log that in BLOCKERS as a known limitation).
2. `email_set_marketing_status` requires `reason`; `never` and upgrades require `confirm: true`. `email_import_csv` defaults `dry_run: true`. `email_send_test` only to the allowlist. `email_create_campaign` always leaves the campaign in `draft`. `email_write_weekly_content({ material, text, week })` writes the featured paragraph used by the digest.
3. Tool descriptions must say what the guard rails are, so a Claude session knows when a call will come back `pending_approval`.
4. Add `docs/email/MCP.md` listing each tool, its arguments and an example call.

**Tests.**
- Integration: every tool invoked once through the MCP server's test harness with valid args returns the documented shape; invalid args are rejected by schema; each call leaves an audit row.
- Integration: a schedule of 51 contacts via MCP → `pending_approval`; `email_send_test` to a non-allowlisted address is refused.

**Done when.** `docs/email/MCP.md` matches the registered tools (write a test that diffs the registry against the doc's tool names).

**Commit.** `email: section 10 — MCP tools`

---

### Section 11 — Admin UI

**Goal.** Spec § Admin UI: the Messaging section, seven pages, over the same services.

**Build.**

1. Add **Messaging** to admin navigation behind the existing admin auth guard. Pages: Contacts (list + detail), Imports, Campaigns (list, editor, approval queue, report), Automations, Templates, Deliverability, Settings — contents per Spec § Admin UI. Use the repo's existing table, form and layout components; no new component library.
2. Campaign editor: subject, preheader, block picker with live preview (three sample contacts, tabs), segment builder with live count (debounced `previewSegment`), schedule + window, A/B toggle, test-send button (allowlist only, shows mode banner), save as draft / schedule / approve (approve only shown to authenticated admin).
3. A persistent banner across the Messaging section showing `EMAIL_SEND_MODE` and the marketing pause state, red when not `live` so nobody wonders why nothing is delivered.
4. Contacts detail: status change with reason (typed), `never` and upgrades behind a confirm dialog; re-verify button; timeline.
5. Deliverability page: rates by class (last 90 days, simple chart using whatever the admin already uses for charts; a table if nothing), reconciliation status, rate-limit bucket, pause switch, DNS check (daily job resolving SPF/DKIM CNAMEs/DMARC via DNS-over-HTTPS and storing pass/fail with the record text).
6. Settings page: every key in `email_settings` with validation.

**Tests.**
- Playwright, logged in as an admin fixture user: create a manual campaign to a 3-contact segment, preview, test-send (sandbox), schedule, see it in the list; change a contact's status with a reason and see the consent event; run an import dry run from the Imports page; toggle the pause switch and see the gate refuse marketing.
- Component tests only where the repo already has them.

**Done when.** The Playwright flow passes headless; every page loads with an empty database and with the dev database.

**Commit.** `email: section 11 — admin UI`

---

### Section 12 — Automations and storefront consent

**Goal.** Spec § Sales-maximising improvements rows 1, 2, 5, 6, 7, 8, 9, 10 as toggled automations; checkout and signup consent capture.

**Build.**

1. `automations/` with one module per automation, each exporting `{ key, defaults, evaluate(now) → candidate sends[] }`, run by a single pg-boss cron `email.automations` every 15 minutes that calls each enabled module and enqueues via `enqueueSend` with idempotency keys that encode the step (`cart:<cartId>:1`, `replenish:<orderLineId>:1`), so re-evaluation never double-sends.
2. **Replenishment**: per order line, `days_to_empty = default_for_material × quantity`; corrected per contact once two orders of the same material exist (median interval); send `replenishment_1` at 85% of the estimate, `replenishment_2` ten days later if no order since; both carry the deep link to the same variant and colour; marketing class.
3. **Abandoned cart**: carts with a captured email and no order; steps at 1 h, 24 h, 72 h (step 3 only if `discount_allowed`); stops on order; one sequence per cart; marketing class. Add email capture at checkout per Part B #10 if missing.
4. **Welcome series**: on `signup_form` consent; day 0, 3, 10; skipped if an order exists; marketing.
5. **Post-purchase**: delivery + 7 days tips for the material bought (content keyed by material in `email_weekly_content`-style table `email_material_content`, seeded with short neutral placeholders and flagged for Roger to edit), delivery + 14 days review request; class `service` (allowed for `transactional_only`); never contains offers (lint: block types `DealsList` and `Hero` forbidden in service templates).
6. **Win-back**: 120 days since last order → `winback_1` in their categories; 240 days → `winback_2` (offer only if allowed); then quarterly; runs `reverifyDormant` first and waits for the batch.
7. **Pre-order and subscription**: hook the existing pre-order ETA change / shipping and subscription renewal / payment-failed events to service sends; "add to your next box" marketing send 7 days before renewal.
8. **Price-drop / low-stock**: product price down ≥ 10% or stock < 5 on an item in a contact's interests or open back-in-stock list; max one per contact per 7 days; counts against the gap.
9. **Trade**: `is_trade` segment variant of the digest (box quantities, trade prices) and a monthly bulk-pricing campaign stub (content empty, disabled).
10. Storefront: checkout consent tick box, shown unticked, wording "Email me about new filament and offers. You can unsubscribe at any time." Ticked → `all`; unticked → `transactional_only`; both recorded as consent events with the form evidence (never pre-tick it). Newsletter signup with interest picker (active opt-in), footer form posting to `POST /api/email/subscribe` with evidence capture and double-check of syntax. All three call `findOrCreateByEmail` and enqueue Bouncer.

**Tests.**
- Integration with fake timers, one per automation: the schedule fires at the right offsets, idempotency holds across repeated evaluation, an order cancels the cart and replenishment sequences, a `transactional_only` contact receives post-purchase but not replenishment, win-back waits for re-verification and skips `invalid` results, service templates refuse offer blocks.
- Integration: checkout with box ticked → `all` with evidence; unticked → `transactional_only`; signup form → `all` + welcome sequence enqueued.
- Playwright: checkout and signup forms render the consent controls at 375 px.

**Done when.** `email.automations` runs against the dev database in sandbox mode and BUILD_LOG records how many candidate sends each automation produced.

**Commit.** `email: section 12 — automations and storefront consent`

---

### Section 13 — Full verification pass

**Goal.** Prove the whole thing works together before handover; fix what the pieces-in-isolation tests missed.

**Build / run.**

1. Fresh test database → migrations → backfill fixture → four-file import fixture → sandbox digest cycle → webhook replay → automations tick → reports. Script it as `scripts/email/e2e-sandbox.ts` and as a single integration test `tests/email/e2e.test.ts`.
2. Load check: 20,000 contacts, a digest expansion, and the sender at 600/h with fake timers — expansion under 30 s, sender batches under 1 s each, reports under 500 ms. Add indexes as needed and record them.
3. Grep audits, each recorded in BUILD_LOG with the result: no direct SendGrid calls outside `lib/sendgrid.ts`; no `live` string in env defaults; no real-looking email addresses in fixtures; no `console.log` of tokens or keys; every marketing template has the unsubscribe link and headers; `imports/` ignored.
4. Run the repo's full test suite, lint and typecheck. Fix everything. Review every `BLOCKED` skip from earlier sections and attempt each once more with the full system in place; un-skip those that now pass.
5. Review `docs/email/IDEAS.md` and `BLOCKERS.md`; make sure every blocker has a "what Roger needs to do" line.

**Done when.** Full suite green; e2e script completes on a fresh database; BUILD_LOG has the audit results.

**Commit.** `email: section 13 — verification pass`

---

### Section 14 — Handover

**Goal.** `docs/email/HANDOVER.md`, written for Roger, that gets the system from sandbox to live safely.

**Write, in this order.**

1. **What was built** — one paragraph and a table of the sections with their commit shas and test counts (from BUILD_LOG).
2. **Decisions taken outside Part B** — every "Decisions taken" line from BUILD_LOG, consolidated.
3. **Blockers** — copy of BLOCKERS.md with the action for each.
4. **Production go-live steps**, as a checklist:
   - Merge `feature/email-marketing`; deploy; run migrations; run `scripts/email/backfill-contacts.ts` and record the counts.
   - Run the four imports with `--dry-run` on production, review the reports, then `--live` in the order bounces → spam → unsubscribes → contacts.
   - SendGrid: confirm the three settings from Part A3; paste the webhook public key into production env; send one sandbox test and confirm a `processed` event arrives at the webhook (the deliverability page shows the last event time).
   - Set `EMAIL_SEND_MODE=allowlist` with your own address; let Wednesday's digest draft generate; approve; receive it Thursday; check one-click unsubscribe from Gmail's own UI works on your address, then re-subscribe via preferences.
   - Register `cleverdeals.net` in Google Postmaster Tools.
   - Parallel run: two weekly cycles in `allowlist` mode alongside the existing SendGrid campaign; compare bounce and complaint rates on the deliverability page against SendGrid's stats.
   - Set `EMAIL_SEND_MODE=live`. Cancel SendGrid Marketing Campaigns the following week. Delete the Marketing Contacts in SendGrid 30 days after that (keep the exports as consent evidence).
5. **What to watch in the first month** — complaint rate (target < 0.1%), bounce rate (< 2%), unsubscribes per campaign, revenue per 1,000 sent per automation; the auto-pause rule and how to resume.
6. **Content Roger must write** — the material tips placeholders in `email_material_content`, the weekly featured paragraphs (or let Claude write them via `email_write_weekly_content`), trade digest copy.
7. **DNS and SendGrid checks not done by code** — SPF simplification, link branding, return-path CNAME (from SPEC.md § Deliverability).
8. **How to operate from Claude** — ten example MCP requests, copied from `docs/email/MCP.md`.

**Commit.** `email: section 14 — handover` and leave the branch ready to merge. Stop.

---

## Part F — If a section cannot start

If a section's prerequisites are missing (a table from section 0 does not exist in this repo, an import file is absent, the MCP server has no registration mechanism), the session does the largest subset that is possible, builds any missing prerequisite in the simplest form that satisfies this runbook (and only this runbook), logs a blocker with what was assumed, and continues. The run only halts if the repository cannot be built or tested at all after section 0; in that case BUILD_LOG records why and HANDOVER.md is written with just the blocker.
