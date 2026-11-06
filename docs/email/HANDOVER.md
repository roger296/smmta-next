# Email system — handover

For Roger. This document covers what was built, what is still open, and the steps from deploy to live mail, testing on real mail to your own test addresses first.

## 1. What was built

Every email the store sends now goes through one module (`apps/api/src/modules/email`). It has one gate (`canSend`: consent, deliverability, gap, window and pause), one sender (a rate-limited worker job that calls SendGrid) and one event log (`email_sends`, `email_events`).

The module covers:

- consent, kept separate from deliverability
- one-click unsubscribe and a preferences page on the shop's own domain
- back-in-stock notices on the shared pipeline
- importing the SendGrid exports
- Bouncer address checks
- the signed SendGrid webhook
- React Email templates with tracked links and add-to-basket links
- the weekly digest and new-product alerts
- manual campaigns with A/B subjects and revenue reports
- 25 MCP tools for Claude
- the admin's **Messaging** section
- seven automations
- consent capture at checkout and a newsletter signup in both shops

**Nothing sends for real yet.** `EMAIL_SEND_MODE` is unset in the compose files, so the sender refuses to run until you set it.

| Section | Commit | Tests added |
| --- | --- | --- |
| 0 Discovery and test harness | `261f5e9` | 5 |
| 1 Schema, consent log, gate | `457bcfa` | 130 (60-cell gate matrix, transitions, trigger, backfill) |
| 2 Unsubscribe and preferences pages | `6f63ee5` | 21 (incl. Chromium at 375 px, JS off) |
| 3 Back in stock through the gate | `b924029` | 8 (existing 19 unchanged) |
| 4 CSV importer | `62a5abe` | 15 |
| 5 Bouncer verification | `73ecc51` | 15 |
| 6 Sender, SendGrid client, webhook | `1095f9c` | 32 |
| 7 Templates and rendering | `92c10c5` | 142 |
| 8 Weekly digest, new-product roll-up | `db39892` | 6 |
| 9 Campaigns, A/B, reports | `5376ae9` | 6 |
| 10 MCP tools | `b02c883` | 6 |
| 11 Admin UI | `7259396` | 5 API + 2 Playwright |
| 12 Automations, storefront consent | `259760f` | 10 API + 41 storefront |
| 13 Verification pass | `1f36576` | e2e + 20,000-contact load check |

Test counts at the end:

- **API:** 1,420 tests, all passing, run twice in a row on the same database.
- **Admin web app:** 141 unit tests passing, plus 2 Playwright tests.
- **Clothes Shop:** 226 tests passing.
- **Filament Store:** 282 passing. The other 6 are in `lib/checkout.test.ts` and fail the same way without this work (a Mollie webhook-URL check in this environment).

Full detail is in [BUILD_LOG.md](BUILD_LOG.md); the specification is [SPEC.md](SPEC.md); the MCP tools are in [MCP.md](MCP.md).

## 2. Decisions taken outside Part B

These are the ones that matter most. Every section's full list is in BUILD_LOG.md.

- **Branch.** The work is on `claude/inspiring-feynman-e88jdq`, not `feature/email-marketing`, because this session had to use that branch.
- **Four email classes.** The schema has `order_required`, `requested_service`, `service` and `marketing`, matching the spec's class table. SendGrid categories still split mail into transactional and marketing.
  - Back in stock is `requested_service`.
  - Pre-order ETA changes and shipping are `order_required`.
  - Post-purchase tips and review requests are `service`.
- **Interests are keyed on materials, not category ids.** Keys look like `material:pla`, worked out from product and range names, because filament products have no material category. Clothes categories still work as `category:<id>`.
- **Unsubscribe links live on the shop's domain.** The storefronts pass `/email/*` through to the API. The send-mode setting decides what actually happens:
  - Unset: the sender refuses to run. This is the default.
  - `sandbox`: SendGrid accepts mail and delivers nothing.
  - `allowlist`: marketing and service mail reach only the test addresses; back-in-stock and order mail still reach customers.
  - `live`: mail goes to everyone the gate allows.
- **There was no MCP server, so one was built** at `POST /api/mcp`. It needs an API key with the `email:mcp` scope. Only a key that also has `email:approve` (yours) can approve campaigns through MCP. Claude's keys never get that scope, so for Claude approval stays in the admin.
- **Every automation starts switched off.** When one is switched on, it only acts on moments from the last few days. Turning on win-back will not mail everyone who lapsed months ago.
- **Not moved onto the new pipeline yet.**
  - Pre-order and subscription-renewal notices. The existing notification agent still sends them, and moving them now would mail customers twice.
  - The shops' own order emails. These are order-required mail, which the gate always allows anyway.
  - Both are listed in [IDEAS.md](IDEAS.md).
- **Ticking the checkout box sets marketing on; leaving it unticked sets transactional-only**, as the runbook says. A subscriber who leaves the box unticked on a later order is therefore unsubscribed. It may be worth changing (IDEAS.md).
- **Add-to-basket links use the shop price, not trade prices** (B3 below).
- **Each distinct email is rendered once and filled in per recipient.** This was done for speed: 50 sends now take about 0.6 s.

## 3. Blockers

The full entries are in [BLOCKERS.md](BLOCKERS.md).

| # | What | What you need to do |
| --- | --- | --- |
| B1 | The SendGrid exports were not in the repo, so the real imports were never run. | Export the four lists, put them in `imports/sendgrid/` on the server (never in git), and run them as in step 4 below. |
| B2 | There was no SendGrid key, so the build never sent a real message through SendGrid. | The first real test send in step 4 below covers it. |
| B3 | Trade prices are not applied in add-to-basket links. | Decide how trade pricing should reach the storefront, and whether `customer_product_prices` are ex-VAT or inc-VAT. |

Also check before go-live: the Bouncer endpoints follow Bouncer's v1.1 documentation but were only tested against stand-in responses. One real check is in step 6 below.

## 4. Production go-live steps

Testing happens on **real mail**, not in SendGrid's sandbox, with `EMAIL_SEND_MODE=allowlist`:

- **Marketing and service mail** (campaigns, the digest, automations, post-purchase tips) is really delivered, but only to the addresses in `EMAIL_TEST_ALLOWLIST`. For anyone else it is dropped and logged as `not_in_allowlist`.
- **Mail a customer asked for, or needs for an order** — today that is back-in-stock notices — goes to everyone, as normal. Real customers keep getting their back-in-stock emails while you test, so there is no rush to finish the test stage.

Work through these in order and tick each one off.

- [ ] **Set the environment in Coolify**, once, in the stack's **Environment Variables** tab. `docker-compose.coolify.yml` hands each variable to the services that need it (the api and the worker):
  - `EMAIL_SEND_MODE=allowlist`
  - `EMAIL_TEST_ALLOWLIST` — your test addresses, comma-separated, e.g. `roger@etailsupport.com,test@cleverdeals.net`. Use mailboxes you can read, ideally one Gmail and one Outlook, so you see how both treat the mail.
  - `EMAIL_TOKEN_SECRET` — run `openssl rand -base64 32`
  - `SENDGRID_API_KEY` — already set for the shops; keep it. It needs Mail Send and Suppressions (read); Full Access covers both.
  - `SENDGRID_WEBHOOK_PUBLIC_KEY` (or the existing `SENDGRID_WEBHOOK_VERIFICATION_KEY`)
  - `BOUNCER_API_KEY`
  - `STOREFRONT_BASE_URL` — the shop origin the emails should link to
  - `EMAIL_ALERT_EMAIL`
- [ ] **Deploy.** Redeploy the api, worker, web and both storefronts from `main`. The API runs migrations 0043–0050 when it starts; they only add tables and columns. Check:
  - the api logs show the migrations applied and no errors;
  - `https://admin.cleverdeals.net/messaging` loads, with a red banner reading "Allowlist mode: marketing goes only to the test addresses…".
  - Then tag the release (`git tag -a vX.Y.Z <merge commit>` and push it).
- [ ] **Check SendGrid's settings:**
  - Tracking: Click on, Open on, Subscription Tracking **off**.
  - Event Webhook: the account allows only one, and Bloodhound already uses it, so the two share it:
    1. In SendGrid, open the **Bloodhound** webhook (gear icon). Copy its Post URL into Coolify as `SENDGRID_WEBHOOK_FORWARD_URL`, and its **verification key** as `SENDGRID_WEBHOOK_PUBLIC_KEY`: each webhook has its own signing key, and both systems check signatures with this one. Redeploy.
    2. Change that webhook's Post URL to `https://admin.cleverdeals.net/api/webhooks/sendgrid` and save. Edit only the URL: switching signing off and on can issue a new key.
    3. Every batch SendGrid sends now reaches this system first and is passed on, unchanged and still signed, to Bloodhound. Check Bloodhound still records events after the switch.
- [ ] **Backfill contacts** from the api container's terminal in Coolify. The scripts run from the API's folder, `/app/apps/api`, not the repo root:
  `cd /app/apps/api && npx tsx scripts/email/backfill-contacts.ts`
  Record the counts it prints in BUILD_LOG.
- [ ] **Import the SendGrid exports.** For each list, run a dry run first, read the report, then run it live. Order: bounces, then spam reports, then unsubscribes, then contacts. From `/app/apps/api`, dry run:
  `npx tsx scripts/email/import.ts --type bounces --file /path/bounces.csv`
  Live run, using the dry-run id it printed:
  `… --live --dry-run-id <id>`
  The admin's **Messaging → Imports** page does the same. For a contacts file, fill in **List name** (it defaults to the file name, e.g. `Maki`): every address in the file is tagged with it, an address on two lists keeps both, and campaigns can then target "On any of these lists".
- [ ] **Give your test addresses marketing consent**, so marketing emails can reach them: sign each one up with the newsletter form in the shop footer (this also tests the form), or add it under **Messaging → Contacts → Record consent**.
- [ ] **First real send.** Make a small campaign to your test addresses (**Messaging → Campaigns → New campaign**) and use **Send test**. Check:
  - it arrives, in the inbox rather than spam, with the From name, links and footer right;
  - **Messaging → Deliverability** shows a recent "Last webhook event" (SendGrid is reporting back);
  - clicking a link in it shows as a click on the campaign report a few minutes later.
- [ ] **Unsubscribe and re-subscribe.** In Gmail, use Gmail's own Unsubscribe button on that email: the address should show as transactional-only in **Messaging → Contacts**. Then re-subscribe from the preferences link in the email.
- [ ] **Back in stock.** Put a test address on a "notify me" for an out-of-stock product, book stock in, and check the email arrives with a working add-to-basket button. (Real customers' notices go out normally throughout.)
- [ ] **The weekly digest.** Wait for Wednesday's draft (or ask Claude to make one now with `email_create_campaign`, kind `weekly_digest`). Look at its three previews under **Messaging → Campaigns**; on Thursday it reaches only your test addresses.
- [ ] **Check Bouncer** by forcing one real check from a contact page (**Re-verify**).
- [ ] **Create an MCP key for Claude** with the `email:mcp` scope (see MCP.md). Give it nothing else.
- [ ] **Register `cleverdeals.net` in Google Postmaster Tools.**
- [ ] **Go live.** Set `EMAIL_SEND_MODE=live` in Coolify (api and worker) and redeploy.
  - Marketing sent while testing to people outside the allowlist was dropped, not saved: nobody gets a backlog of old emails when you switch.
  - Switch on the automations you want (**Messaging → Automations**). Replenishment, abandoned basket and welcome are the high-value ones.
  - Watch the first week's digest on **Messaging → Deliverability** against SendGrid's own stats. Once it looks right, cancel SendGrid Marketing Campaigns.
  - Delete the SendGrid Marketing Contacts 30 days later. Keep the export files: they are your consent evidence, and copies are in the `email-evidence` volume.

## 5. What to watch in the first month

- **Complaint rate:** target under 0.1%. Marketing pauses itself at 0.2%.
- **Bounce rate:** target under 2%. Marketing pauses itself at 3%.
- **Unsubscribes per campaign:** shown on each campaign report.
- **Revenue per 1,000 sent**, per campaign and per automation. This is the number to compare things on; open rates are unreliable.
- **Auto-pause.** If marketing pauses itself, you get an email, an alert shows on the Deliverability page and the red banner shows on every Messaging page. Fix the cause, then press **Resume marketing**, or ask Claude to use `email_resume_marketing`. Order and requested mail keep going while marketing is paused.

## 6. Content you should write

- **Printing tips per material.** The `email_material_content` table holds short neutral placeholders that the post-purchase emails use. Edit them; each row has a `needs_review` flag.
- **Weekly featured paragraphs and deals.** Add them under **Messaging → Campaigns**, or have Claude write them with `email_write_weekly_content`. The digest only includes a featured paragraph when it also has real news for that person.
- **Trade copy.** Trade contacts see a trade price only when one is supplied; nothing supplies one yet (B3).

## 7. DNS and SendGrid checks the code does not do

- **SPF.** Simplify the record to `v=spf1 include:_spf.google.com include:sendgrid.net ~all`. The `dnssmarthost` include and the `+a` / `+mx` entries are dead weight (SPEC.md § Deliverability).
- **Link branding.** In SendGrid, under Settings → Sender Authentication → Link Branding, confirm it is set up and verified, and check the return-path CNAME (`em….cleverdeals.net`) on the same page.
- **DMARC failures.** Treat a DKIM failure report from PowerDMARC as a reason to stop sending.
- **Daily check.** The Deliverability page shows a daily check of the SPF, DKIM and DMARC records.

## 8. Operating it through Claude

Each request below names the MCP tools Claude would use. MCP.md has the arguments.

1. "Show me this week's digest and three previews" — `email_get_campaign_report {status: "scheduled"}`, then `email_render_preview`.
2. "Write the PETG paragraph for this week" — `email_write_weekly_content`.
3. "Who in PETG hasn't ordered in 90 days?" — `email_preview_segment`.
4. "Draft a win-back to them" — `email_create_campaign`.
5. "Send me a test" — `email_send_test` (only to the addresses in `EMAIL_TEST_ALLOWLIST`).
6. "Schedule it for Thursday 10:00" — `email_schedule_campaign`. Above 50 people it waits for your approval.
7. "Why did last Thursday's digest get four unsubscribes?" — `email_get_campaign_report`, then `email_list_contacts`.
8. "Import this list as a dry run and show me the conflicts" — `email_import_csv`.
9. "This customer phoned to say never email them" — `email_set_marketing_status` with `confirm: true`.
10. "Pause marketing until I say otherwise" — `email_pause_marketing`.
