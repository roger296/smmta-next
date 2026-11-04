# CleverDeals Email Marketing System — Specification & Build Plan

Nov 4, 2026 · Roger Butterworth / Claude

## Summary

Build a **Messaging** module inside admin.cleverdeals.net that owns every email the store sends — transactional, back-in-stock and marketing — through one gate, one sender and one event log, and retire SendGrid Marketing Campaigns (about £45/month at today's rate). The back-in-stock sender becomes the first client of the shared pipeline rather than a thing the marketing code imitates.

The brief is sound and most of it maps directly onto patterns already running in Beagle (SendGrid v3 API, signed event webhook, Bouncer verification, suppression list, tick-based rate-limited sending, approval-before-send, MCP as the primary operator interface). The spec below reuses those rather than inventing new ones.

Six changes to the brief are recommended, in order of importance:

1. **Keep consent and deliverability as two separate fields.** The three consent statuses are right. A hard bounce or spam complaint is not an unsubscribe and should not be recorded as one, but it must still stop sending. Add a deliverability field beside the consent field.
2. **Make "everyone gets an email every week" a cap, not a target.** Send the weekly email only to people with something relevant to show them, and never let a new-product alert and the weekly email land in the same week for the same person. Over-mailing a filament list raises spam complaints, and with DMARC set to `p=reject` and Gmail's 0.3% complaint threshold, a complaint spike on marketing degrades order-confirmation delivery on the same domain.
3. **Own the unsubscribe, including RFC 8058 one-click.** Gmail and Yahoo require `List-Unsubscribe` + `List-Unsubscribe-Post` headers and a working one-click endpoint for bulk senders. The system must serve these itself; SendGrid's subscription tracking should be off so there is one source of truth.
4. **Import SendGrid's suppression lists too, not just subscribers and unsubscribes.** Bounces and spam reports are a separate export and are the addresses most likely to hurt reputation if re-mailed.
5. **Do not create full customer records for imported unsubscribes.** They are not customers; put them in a contacts table (or flag them) so customer counts, exports and the AI sales agent are not polluted with thousands of people who have never bought anything.
6. **Add replenishment reminders and abandoned-cart recovery in the first build.** Filament is consumable. A "time to reorder?" email timed to the customer's own usage is the single highest-return automation this store can run, and it is cheap once the pipeline exists.

The DNS for cleverdeals.net is in good shape (SendGrid DKIM aligned, DMARC reject, MTA-STS, BIMI). Two tidy-ups are listed in the deliverability section; neither blocks the build.

Estimated effort: about 20 working days of Claude Code sessions across seven phases, with the existing SendGrid marketing cancelled at the end of phase 7 after a two-week parallel run.

## Problems with the approach as described

None of these is a reason not to build; each is a place where the brief as written would cause trouble later.

| # | In the brief | Problem | Do this instead |
| --- | --- | --- | --- |
| 1 | Status fields on the customer record | Consent (what they agreed to) and deliverability (whether the address works) get mixed. A bounced address would have to be marked "transactional only" or "never", which is wrong on both counts and loses the audit trail. | Two fields: `marketing_status` (your three values) and `deliverability` (ok / soft bounces / hard bounced / complained / invalid). Plus a consent event log with source, actor, timestamp, IP. |
| 2 | Unsubscribed list uploaded as customer records | Thousands of non-customers appear in customer lists, counts, exports and the AI sales agent's context. | A `contacts` table keyed by normalised email. A customer links to a contact; an imported unsubscribe is a contact with no customer. Everything else in the brief works unchanged. |
| 3 | "Never Email" | Order confirmations, refunds and dispatch notices are part of the contract and must still go, or you breach consumer law and generate chargebacks. | Define Never Email as "no email except those required to fulfil an order the person has placed". Document the exact list in the email-class table. |
| 4 | Everyone subscribed gets an email every week | A fixed weekly blast to a hobbyist list drives complaints and unsubscribes within a few months and shares reputation with your transactional mail. | Weekly send is the maximum marketing frequency. Each person gets the weekly email only if their digest has at least one relevant block (new in their interests, back in stock, a deal). Empty digest = no send. |
| 5 | Marketing email in response to each new product | Adding five products on a Monday sends five emails. | Roll new products up into one alert per day per interest group, and suppress the alert if the person's weekly digest is due within 48 hours (the digest carries it instead). |
| 6 | Unsubscribe handled by the system | The brief does not mention one-click unsubscribe. Gmail and Yahoo have required `List-Unsubscribe-Post` (RFC 8058) for bulk senders since 2024, processed within two days, and they count it in sender reputation. | Build the one-click endpoint and headers in phase 1. Turn SendGrid subscription tracking off so there is one suppression source, and poll SendGrid's global suppressions nightly as a safety net. |
| 7 | Upload subscribers and unsubscribes | Bounced and spam-reported addresses live in a third SendGrid export (Suppressions → Bounces / Spam Reports). Re-mailing those is worse for reputation than mailing an unsubscribe. | Import all four SendGrid lists. Bounces and spam reports set `deliverability`, not `marketing_status`. |
| 8 | No check on uploaded addresses | Fine for consent lists checked recently, but anything dormant 12+ months has a meaningful dead-address rate. | Skip Bouncer on import as planned, but re-verify any contact with no open/click/order in 12 months before including it in a win-back send. |
| 9 | Existing unsubscribed list must not be mailed without new permission | Correct — PECR regulation 22. The same rule applies to the subscriber list: you need evidence of consent (or soft opt-in from a purchase) for each address. | Record `consent_source` and `consent_at` on import from the SendGrid export's created-at column. Keep the raw export file as evidence. |
| 10 | Interests updated as the customer orders | Orders alone give you nothing until the second purchase, and never tell you about products the person looked at and did not buy. | Also update interests from back-in-stock requests, pre-orders, subscriptions, and clicks in emails (the webhook tells you which link). Weight by recency. |
| 11 | Spread sends to avoid overloading the system | The constraint is not SendGrid (it will take thousands per minute); it is your own render and database load, and the pattern receiving domains see. | A pg-boss sender job with a token bucket (default 600/hour, configurable), digest spread over a 2–3 hour window, and jittered start times. |
| 12 | Claude as a primary interface | Fine, but an agent that can send to the whole list needs the same guard rails Beagle has. | Any send to more than N contacts (default 50) requires human approval unless the campaign type is pre-approved; every MCP action is logged with the actor; test sends to an allowlist are always permitted. |
| 13 | Same From address and domain for marketing and transactional | Simplest, and matches the brief. The cost is that one bad campaign can hurt order emails. | Acceptable at current volume. Use SendGrid categories (`transactional`, `marketing`) from day one so the split is visible, and keep the option of a `news.cleverdeals.net` sending subdomain for marketing if complaint rate ever exceeds 0.1%. |

## Data model

Six new tables in the existing Postgres database, plus one column on `customers`. Every address the store knows lives in `email_contacts` once, whether or not it belongs to a customer.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `email_contacts` | One row per address; the thing consent attaches to | `id`, `email` (lower-cased, trimmed, unique), `customer_id` (nullable FK), `marketing_status` enum `all` / `transactional_only` / `never`, `status_changed_at`, `status_reason`, `consent_source` (`checkout`, `signup_form`, `sendgrid_import`, `admin`, `mcp`), `consent_at`, `consent_evidence` (jsonb: IP, user agent, form, import file), `deliverability` enum `ok` / `soft_bounce` / `hard_bounce` / `complained` / `invalid`, `soft_bounce_count`, `bouncer_result`, `bouncer_checked_at`, `interests` jsonb `{category_id: {score, last_at}}`, `is_trade` bool, `last_marketing_at`, `last_open_at`, `last_click_at`, `last_order_at`, `unsubscribe_token` (random, unique) |
| `email_consent_events` | Append-only audit of every status change | `contact_id`, `from_status`, `to_status`, `source` (`one_click`, `link`, `preferences_page`, `csv_import`, `admin_ui`, `mcp`, `complaint_webhook`), `actor` (user id, `claude`, `system`), `ip`, `user_agent`, `created_at` |
| `email_campaigns` | A thing that sends to many contacts | `id`, `kind` enum `weekly_digest` / `new_product` / `back_in_stock` / `manual` / `automation`, `class` enum `transactional` / `marketing`, `status` enum `draft` / `pending_approval` / `scheduled` / `sending` / `sent` / `cancelled`, `segment` jsonb, `audience_count`, `subject`, `preheader`, `template_id`, `content` jsonb (blocks the template renders), `variant_of` (for A/B), `scheduled_at`, `send_window_minutes`, `created_by`, `approved_by`, `approved_at`, `utm_campaign` |
| `email_sends` | One row per message to one contact | `id`, `campaign_id` (nullable for one-offs), `contact_id`, `class`, `kind`, `idempotency_key` (unique), `sendgrid_message_id`, `status` enum `queued` / `sent` / `delivered` / `deferred` / `bounced` / `dropped` / `opened` / `clicked` / `complained` / `unsubscribed`, `queued_at`, `sent_at`, `delivered_at`, `first_open_at`, `first_click_at`, `error` |
| `email_events` | Raw SendGrid webhook events, kept 13 months | `send_id`, `event`, `sg_event_id` (unique), `payload` jsonb, `received_at` |
| `email_templates` | Rendered with React Email or MJML | `id`, `key`, `subject_template`, `body_source`, `version`, `class` |
| `email_imports` | Each CSV upload | `id`, `filename`, `list_type`, `default_status`, `default_interests`, `row_count`, `created`, `updated`, `skipped`, `conflicts`, `dry_run`, `created_by` |
| `customers.contact_id` | Link from customer to its address row | FK, set when the customer is created or when an import matches an existing customer by email |

Rules that the model enforces, not the UI:

- `email` is unique per contact. A customer changing their email creates a new contact (or claims an existing one) and the old one keeps its own history.
- `marketing_status` only moves through `email_consent_events`; a database trigger refuses direct updates so Claude, the UI and webhooks all leave the same trail.
- Downgrades are automatic (unsubscribe, complaint). Upgrades to `all` happen only from a form the person submitted or an admin action with a typed reason; `never` → anything requires admin.
- `interests` scores decay: each category's score halves every 180 days, and an order, pre-order, subscription or back-in-stock request adds 10, an email click adds 2. Segments use "score above 3" as "interested".
- `is_trade` is set from the existing trade-discount logic so trade customers can be segmented and mailed differently (bulk pricing, new colours by the box).
- Existing `back_in_stock_requests` is unchanged; its sender is rewritten to create an `email_sends` row of class `transactional`, kind `back_in_stock`, through the same gate.

## Email classes and consent rules

Every send passes through one function, `canSend(contact, class, kind)`, and nothing else in the codebase calls SendGrid. The table is the whole policy; the function implements it.

| Class | Examples | Accepts all | Transactional only | Never Email | Hard bounce / complained / invalid |
| --- | --- | --- | --- | --- | --- |
| Order-required | Order confirmation, payment received, dispatch, delivery, refund, pre-order ETA change, bank-transfer instructions, password reset | Yes | Yes | Yes | Yes, one attempt (the order needs it; the webhook tells you if it fails) |
| Requested service | Back in stock, pre-order now available, subscription renewal notice, subscription payment failed, low-stock on a subscribed item | Yes | Yes | No | No |
| Service, no offer | Review request 10 days after delivery, "how is your print going" tips for the material bought | Yes | Yes | No | No |
| Marketing | Weekly digest, new-product alert, promotions, abandoned cart, replenishment reminder, win-back, welcome series | Yes | No | No | No |

Additional gates for the marketing class, all configurable in settings:

- At most one marketing email per contact per 7 days (`marketing_min_gap_days`, default 7). A new-product alert due inside the gap is folded into the next digest instead.
- No marketing to a contact with `last_marketing_at` in the last 24 hours even if the gap setting is lowered.
- No marketing to a contact whose last six marketing emails were all unopened and unclicked; move them to a quarterly "still interested?" cadence instead (Apple Mail Privacy Protection makes opens unreliable, so count clicks and orders as engagement, and treat opens as a weak signal only).
- Send window 08:00–20:00 UK for marketing; requested-service emails go immediately because the person asked for them.
- A contact in `soft_bounce` with `soft_bounce_count` ≥ 3 in 30 days is treated as hard-bounced until a successful delivery resets the count.
- Abandoned-cart and replenishment emails count as marketing under PECR even though they are personal; they go to `all` only. Existing customers who bought and were offered an opt-out at checkout are covered by soft opt-in, so the checkout form must show the opt-out tick box (unticked = subscribed is allowed for soft opt-in; for the standalone signup form the box must be an active opt-in).

Status transitions:

| Trigger | New status | Who |
| --- | --- | --- |
| Checkout or signup form | `all` | System, with the form's consent evidence |
| Unsubscribe link, one-click header, preferences page | `transactional_only` | Person |
| Spam complaint event from SendGrid | `transactional_only` + `deliverability = complained` | Webhook |
| "Please never email me" by any channel | `never` | Admin or Claude via MCP, typed reason required |
| Re-subscribe on preferences page or a new order with the box ticked | `all` | Person (never from `never`) |
| Admin override | Any | Admin, typed reason; logged |

## CSV import

Four imports, run in a fixed order so that the safest status always wins: bounces and spam reports first, then unsubscribes, then subscribers. An address that appears in more than one file ends up with the most restrictive result.

| Order | SendGrid export | Creates | Sets |
| --- | --- | --- | --- |
| 1 | Suppressions → Bounces | Contact | `deliverability = hard_bounce`, `marketing_status = transactional_only` |
| 2 | Suppressions → Spam Reports | Contact | `deliverability = complained`, `marketing_status = transactional_only` |
| 3 | Global + group unsubscribes | Contact | `marketing_status = transactional_only`, `consent_source = sendgrid_import` |
| 4 | Marketing Contacts (all lists) | Contact | `marketing_status = all` only if the address is not already present; `consent_source = sendgrid_import`, `consent_at` from the export's created-at column |

Import behaviour:

- Every import runs as a **dry run first** and reports: rows read, valid, syntactically invalid, duplicates within the file, already present (and what would change), conflicts (would downgrade an existing `all` to `transactional_only`, or would upgrade — upgrades are never applied by import). The live run only proceeds from a dry run the operator has seen.
- Email normalisation: trim, lower-case, strip surrounding angle brackets and mailto:. No Gmail dot-folding; treat the address as given.
- An imported address that matches an existing customer links to that customer and sets its status; it never creates a second contact.
- An address already at `never` is never changed by any import.
- Interests: the upload form takes a default set of categories applied to every row, and an optional `interests` column (semicolon-separated category keys) that overrides it per row. The subscriber export from SendGrid can carry list membership as a column, which maps onto interests if your lists were by material.
- Each row is written with the `import_id` and row number in `consent_evidence`, and the original file is stored (object store, same as Beagle's evidence store) so there is proof of where each consent came from.
- Imports are idempotent: re-running the same file changes nothing, so a failed upload can be retried.
- The same importer handles future one-off lists (a trade show list, an influencer's audience) with `consent_source` set from the form.

Expected size: whatever is in SendGrid today. The importer streams the file and writes in batches of 500, so list size is not a concern.

## Address verification with Bouncer

Bouncer runs on every address the website collects, after the fact, and never in the request path. Checkout and signup must not wait on a third-party API.

1. A new contact (checkout, signup form, back-in-stock request, pre-order) is created with `deliverability = ok` and `bouncer_result = null`, and a `verify_email` job is queued.
2. The job calls Bouncer's single-verify endpoint (same client as Beagle) and stores the result and the timestamp.
3. Result handling: `deliverable` → no change. `undeliverable` → `deliverability = invalid`; the order-required email that is already in flight is allowed, and its bounce event confirms the verdict. `risky` (catch-all, disposable, role address) → stays `ok` with the result stored; first soft bounce moves it to `hard_bounce` rather than waiting for three. `unknown` → retry once after 24 hours, then treat as `risky`.
4. A result is good for 90 days. The job skips any contact verified inside that window, so a repeat customer is not re-checked on every order.
5. Before any win-back or re-engagement campaign, contacts with no click, open or order in 12 months are re-verified in bulk (Bouncer's batch endpoint) and the campaign waits for the batch to finish.
6. Imported addresses are not verified, as the brief says. The nightly deliverability job still watches their bounce events like any other contact.

Cost is pennies per check at this volume and only new addresses are checked, so it is not worth budgeting separately. The existing `BOUNCER_API_KEY` pattern from Beagle is reused.

## Sending pipeline

One gate, one sender job, one webhook. The back-in-stock sender, the weekly digest and an order confirmation all take the same path; only the class and the template differ.

*(Diagram in the original: Triggers (UI, MCP, store events) → Campaign service (draft, approve, send) → Audience + gate (segment, then canSend()) → Sender job (pg-boss, 600/hour) → SendGrid v3 (mail/send, categories) → Event webhook (signed, idempotent) → Send log (sends, events, status) → feeds consent and deliverability back into the gate; Unsubscribe pages (one-click, preferences) write to the send log and contacts.)*

Triggers create campaigns or single sends; the gate decides per contact; the sender job meters calls to SendGrid; the webhook writes every delivery event back to the send log, and the log feeds consent and deliverability back into the gate. Unsubscribe pages write directly to the log and contacts.

**Sending.** A campaign in `scheduled` state is expanded by the audience builder into one `email_sends` row per contact (status `queued`, unique `idempotency_key` = campaign id + contact id). A pg-boss job `send_email` takes rows in batches of 50, re-checks `canSend` at send time (consent may have changed since scheduling), renders the template with the contact's personalisation, and calls SendGrid `POST /v3/mail/send` with:

- `custom_args`: `send_id`, `campaign_id`, `contact_id`, `class`, `kind` — these come back on every webhook event.
- `categories`: `[class, kind]` so SendGrid's own stats split transactional from marketing.
- `headers`: `List-Unsubscribe: <https://cleverdeals.net/email/u/{token}>, <mailto:unsubscribe@cleverdeals.net?subject={token}>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` on every marketing send. Not on order-required emails.
- `reply_to`: sales@cleverdeals.net; `from`: `CleverDeals <sales@cleverdeals.net>`.
- Tracking settings: click tracking on, open tracking on, subscription tracking **off** (the system owns unsubscribes).

**Throttling.** The job is rate-limited by a token bucket in Postgres (`email_rate_limit` row, refilled per minute), default 600 sends per hour, configurable in settings. A campaign with `send_window_minutes` spreads its queue evenly across the window with ±10% jitter per row. The weekly digest defaults to a 180-minute window. Requested-service emails (back in stock) bypass the window but not the bucket. SendGrid 429 or 5xx responses retry with exponential backoff (1, 4, 16, 64 minutes, then fail); 4xx other than 429 marks the send `dropped` with the error body.

**Webhook.** `POST /api/webhooks/sendgrid` verifies the ECDSA signature with the stored public key (same code as Beagle's `SENDGRID_WEBHOOK_PUBLIC_KEY` handler), inserts each event into `email_events` keyed on `sg_event_id` (duplicates ignored), and applies:

| SendGrid event | `email_sends.status` | Contact change |
| --- | --- | --- |
| `processed`, `deferred` | `sent` / `deferred` | none |
| `delivered` | `delivered` | `soft_bounce_count = 0` |
| `bounce` (type bounce) | `bounced` | `deliverability = hard_bounce` |
| `bounce` (type blocked), `deferred` ×3 | `bounced` | `soft_bounce_count += 1`; at 3 in 30 days → `hard_bounce` |
| `dropped` | `dropped` | if reason is invalid address → `invalid` |
| `open` | `opened` (first only) | `last_open_at` |
| `click` | `clicked` (first only) | `last_click_at`; interest +2 for the clicked product's category |
| `spamreport` | `complained` | `deliverability = complained`, `marketing_status = transactional_only` via consent event |
| `unsubscribe`, `group_unsubscribe` | `unsubscribed` | should not occur with subscription tracking off; handled the same as a link unsubscribe if it does |

**Unsubscribe endpoints**, no login, token in the URL:

- `POST /email/u/{token}` with body `List-Unsubscribe=One-Click` → immediate `transactional_only`, 200, no page. This is what Gmail and Yahoo call.
- `GET /email/u/{token}` → a one-button confirmation page, then the same change. Shows what they will still receive.
- `GET /email/preferences/{token}` → tick-box page: interests, weekly digest on/off, new-product alerts on/off, unsubscribe from all marketing. Saves as consent events.
- `unsubscribe@cleverdeals.net` → a Google Workspace group or filter forwarding to a small SendGrid Inbound Parse endpoint (Beagle already has one) that reads the token from the subject. Optional in phase 1; the one-click POST is what matters.

**Safety net.** A nightly job pulls SendGrid's global suppressions, bounces and spam reports via the API and reconciles any address the webhook missed. Another nightly job computes the last 7 days' bounce rate and complaint rate per class; marketing pauses itself if complaints exceed 0.2% or bounces 3%, and sends Roger an alert, mirroring Beagle's `bounce_pause_rate`.

Replies to sales@cleverdeals.net land in the Google Workspace inbox as today (MX is smtp.google.com); nothing in the system reads them.

## Campaign types

The three the brief asks for, plus the automations recommended in the next section, all run as `email_campaigns` rows created by scheduled jobs. Claude or the UI can edit any of them before they go out; none of them require a human to remember to press send.

**Weekly digest** (marketing, Thursday 10:00 UK, 180-minute window). Built per contact from blocks, in this order, and sent only if at least one block is non-empty:

1. New products in the contact's interested categories since their last digest.
2. Back in stock in those categories (items with a back-in-stock request get a separate transactional email; this block is for the rest).
3. Current deals and bundle discounts, filtered to their categories.
4. One featured product or tip (Claude writes a short paragraph per material per week; the same paragraph serves everyone with that interest).
5. For contacts with no interests yet: the store-wide new-in and best-sellers blocks.

The campaign is created every Wednesday as a draft with the audience count and a rendered preview for three sample contacts; it sends Thursday unless cancelled. Claude's weekly job writes the subject line and the featured paragraph and posts the draft for review.

**New-product alert** (marketing, daily roll-up at 11:00 UK). Every product added or made purchasable in the last 24 hours, grouped by category, sent to contacts with that interest who are outside their 7-day marketing gap and whose digest is not due within 48 hours. One email per contact regardless of how many products were added. A product flagged `hero` in admin (a new material, a big-name brand) may override the gap once, by a human or Claude setting `override_gap = true` on the campaign.

**Back in stock** (requested service, immediate). The existing feature, rewritten to create a send through the gate. Rules added: one email per request, sent when stock crosses from 0 to ≥ 1; if the item sells out again inside 24 hours a second email is not sent; the request closes on send or after 180 days; the email carries a one-click add-to-cart link for the exact variant and colour. A contact with ten open requests gets one email listing all that came back today, not ten.

**Manual campaign** (marketing). Any one-off: a sale, a Black Friday sequence, a clearance. Created in the UI or by Claude through MCP with a segment, subject, content blocks and schedule. Supports an A/B subject-line variant: 20% of the audience split between two subjects, the winner by click rate after 2 hours goes to the remaining 80%.

**Automations** (marketing unless stated), each a toggle with its own cadence settings, detailed in the next section: welcome series, abandoned cart, replenishment reminder, post-purchase review, win-back, pre-order and subscription nudges.

Every campaign carries `utm_source=email`, `utm_medium=` class, `utm_campaign=` campaign id on every link, and the store attributes an order to a campaign if the customer clicked within the previous 5 days. Revenue per campaign is the number the reports lead with; open rate is shown but not relied on.

## Sales-maximising improvements

Ranked by expected revenue per hour of build time. The first three should be in the first release; the rest can follow once the pipeline exists, as each is a template plus a scheduled job.

| Rank | Automation | Why it sells filament | Trigger and timing | Class |
| --- | --- | --- | --- | --- |
| 1 | Replenishment reminder | Filament runs out. A 1 kg spool at hobby usage lasts 4–8 weeks. Reminding the customer a few days before they run out, with a one-click reorder of the same material and colour, converts far better than any newsletter. | Per order line: estimate days-to-empty from quantity × a per-material default (editable), corrected by the customer's own reorder history once there are two orders. Send at 85% of the estimate; one follow-up 10 days later if no order. | Marketing |
| 2 | Abandoned cart | Standard e-commerce recovery; typically the highest revenue-per-send automation in any store. | Cart with an email captured and no order: 1 hour (reminder with cart contents), 24 hours (reminder + stock note, "3 left"), 72 hours (only if a discount policy is enabled). Stops the moment an order is placed. | Marketing |
| 3 | Interest-based segmentation | Sending PLA people PETG news trains them to ignore you. Everything above already uses interests; this item is making sure every send does. | Built into the gate and audience builder. | — |
| 4 | One-click reorder and add-to-cart links | Every email links straight into a pre-filled cart for the exact variant, with the contact's trade pricing applied. Removes the biggest drop-off between email and checkout. | Signed deep link `/cart/add?sku=…&t=…` that logs the contact in softly (cart only, no account access). | — |
| 5 | Welcome series | New subscribers buy in the first fortnight or not for months. | Signup: immediately (what we stock, how to choose a material), day 3 (best-sellers in the interest they picked), day 10 (first-order offer if policy allows). Skipped for people who already ordered. | Marketing |
| 6 | Post-purchase | Review requests lift conversion on product pages; printing tips for the material bought reduce returns and build the relationship. | Delivery + 7 days: tips; delivery + 14 days: review request. Plain service content, no offers. | Service |
| 7 | Win-back | A customer with no order in 120 days is worth one targeted nudge. | 120 days since last order: "new since you last visited" in their categories; 240 days: offer if policy allows; then quarterly cadence only. Re-verify with Bouncer first. | Marketing |
| 8 | Pre-order and subscription nudges | The platform already supports both; email is how they get sold. | Pre-order: ETA confirmed, ETA moved, now shipping (all service). Subscription: upcoming renewal 3 days before (service), "add to your next box" one week before (marketing). | Mixed |
| 9 | Price-drop and low-stock alerts | People who requested a back-in-stock or viewed a product respond to scarcity and price. | Product price falls ≥ 10% or stock falls below 5 on an item in the contact's interests or request list. Max one per contact per week, counts against the marketing gap. | Marketing |
| 10 | Trade segment | Trade customers want box quantities, new colours in bulk and net pricing, not hobbyist tips. | `is_trade` segment with its own digest variant and a monthly "bulk pricing update". | Marketing |
| 11 | Send-time optimisation | Once 3+ months of click data exist, send each contact's digest in the 2-hour slot they most often click in. | Per-contact `preferred_hour` computed weekly from click timestamps; falls back to the campaign default. | — |
| 12 | Claude-written per-segment copy | Subject lines and intro paragraphs per material segment, with the previous week's click rates in the prompt so the copy learns. | Weekly job, outputs to the draft for approval. | — |

Measure all of this on revenue attributed per send and per contact, not opens. The reports section of the UI shows for each campaign: sent, delivered, clicked, orders, revenue, unsubscribes, complaints, and revenue per 1,000 sent, so Claude can compare automations on the same basis.

Things deliberately left out: SMS (PECR consent you do not hold), discount codes in every email (trains the list to wait for discounts; keep codes for abandoned-cart step 3 and win-back only, behind a policy toggle), and a dedicated IP (your volume is below the point where it helps).

## MCP interface

The MCP server is the same one the admin backend already exposes to Claude; these tools are added to it under an `email_` prefix. Every call is logged with actor `claude`, and the same guard rails Beagle uses apply: Claude can draft, preview and schedule freely, but a marketing send to more than `approval_threshold` contacts (default 50) goes to `pending_approval` until a human approves in the UI or calls `email_approve_campaign` from a session that is flagged as Roger's.

| Tool | Does | Guard |
| --- | --- | --- |
| `email_list_contacts` | Filter by status, deliverability, interest, engagement, trade, last order; paged | Read |
| `email_get_contact` | Contact, consent events, last 50 sends with events, interests, orders summary | Read |
| `email_set_marketing_status` | Change status with a required `reason`; `never` and any upgrade to `all` require `confirm: true` | Write, logged |
| `email_import_csv` | Runs an import; `dry_run` defaults to true and returns the report; live run needs the dry-run id | Write |
| `email_get_import` | Import report and conflicts | Read |
| `email_preview_segment` | Audience count and 10 sample contacts for a segment definition, after the gate | Read |
| `email_create_campaign` | Kind, class, segment, subject, preheader, content blocks, schedule, window, A/B variant | Write; stays `draft` |
| `email_render_preview` | Rendered HTML and text for a campaign as 3 named contacts would see it | Read |
| `email_send_test` | Sends the campaign to addresses on the test allowlist only | Write, always allowed |
| `email_schedule_campaign` | Moves draft to `scheduled` or `pending_approval` by the threshold | Write |
| `email_approve_campaign` / `email_cancel_campaign` | Approval and cancellation; a sending campaign can be paused mid-run | Write, logged |
| `email_get_campaign_report` | Sent, delivered, clicked, orders, revenue, unsubscribes, complaints, per-link clicks; A/B results | Read |
| `email_list_automations` / `email_update_automation` | Toggle each automation, change cadence and policy settings (discount allowed, thresholds) | Write |
| `email_get_deliverability` | 7/30-day bounce and complaint rates by class, SendGrid suppression reconciliation status, pause state | Read |
| `email_pause_marketing` / `email_resume_marketing` | Global marketing kill switch | Write, logged |
| `email_get_settings` / `email_update_settings` | Rate limit, send window, gap days, thresholds, from name, test allowlist | Write, logged |
| `email_record_consent` | Record consent gathered elsewhere (a trade show, a phone call) with source and evidence text | Write, logged |

Typical Claude workflows these enable: "draft this week's digest and show me three previews"; "who in PETG hasn't ordered in 90 days, and what would a win-back to them look like?"; "why did last Thursday's digest get four unsubscribes?"; "import this list as a dry run and tell me what conflicts"; "pause marketing until I say otherwise".

## Admin UI

A **Messaging** section in admin.cleverdeals.net, built on the existing admin layout and auth. It is a thin UI over the same service layer the MCP tools call; nothing is possible in the UI that Claude cannot do, and vice versa, except approval, which is UI-only by design.

| Page | Contents |
| --- | --- |
| Contacts | Table with filters (status, deliverability, interest, engagement, trade, source); bulk status change with reason; CSV export of any filter. Contact detail: timeline of sends and events, consent history, interests with scores, linked customer and orders, buttons for status change and re-verify. |
| Imports | Upload form (file, list type, default status, default interests, consent source); dry-run report with conflicts listed; "run live" button; history of imports with their reports and the stored file. |
| Campaigns | List by status; editor with subject, preheader, block picker (product grid from a category, deal, text, featured, back-in-stock list), live preview as three sample contacts, test send, segment builder with live count, schedule and window, A/B subject; approval queue for `pending_approval`; per-campaign report with per-link clicks and attributed orders. |
| Automations | One card per automation with on/off, cadence fields, policy toggles (discount allowed, discount code), and its last-30-day report. |
| Templates | Base layout (header, footer with address and unsubscribe, colours), per-kind templates, version history, preview. |
| Deliverability | Bounce and complaint rate by class over 90 days, SendGrid suppression reconciliation, rate-limit status, pause switch, DNS check results (SPF, DKIM, DMARC re-checked daily). |
| Settings | Rate limit, send window, marketing gap days, approval threshold, from name, reply-to, test allowlist, weekly digest day and time, interest decay. |

Public pages on the storefront domain, unauthenticated, token in URL: `/email/u/{token}` (unsubscribe, GET and one-click POST), `/email/preferences/{token}`. Both are plain server-rendered pages with the store header so they look trustworthy.

Checkout and signup changes on the storefront: a consent tick box at checkout (soft opt-in wording, unticked allowed), an interest picker on the newsletter signup form (choose materials), and the footer newsletter form posting to the new contacts endpoint with consent evidence captured.

## Deliverability: DNS and SendGrid configuration

sales@cleverdeals.net is fit to send from today. Checked 4 Nov 2026 by DNS lookup; every record SendGrid and the mailbox providers need is present and the DMARC policy is already at `reject`, which is the strictest setting.

| Record | Found | Verdict |
| --- | --- | --- |
| SPF (`cleverdeals.net` TXT) | `v=spf1 +a +mx include:cleverdeals.net.spf.auto.dnssmarthost.net include:_spf.google.com include:sendgrid.net ~all` | Passes, 6 of the 10 permitted lookups used. Carries dead weight (below). |
| DKIM for SendGrid | `s1._domainkey` and `s2._domainkey` CNAME to `*.u38419933.wl184.sendgrid.net` | SendGrid domain authentication is in place; SendGrid signs as `d=cleverdeals.net`, so DKIM aligns with the From address and DMARC passes. |
| DKIM for Google Workspace | `google._domainkey` TXT, 2048-bit key | Replies and human mail from sales@ are signed. |
| DMARC (`_dmarc`) | CNAME to PowerDMARC hosted record: `v=DMARC1; p=reject; rua=…; ruf=…; t=y;` | Reject at 100%, aggregate and forensic reports to PowerDMARC. `t=y` is not a DMARC tag and is ignored; harmless. |
| MX | `smtp.google.com` | Replies to sales@ land in Google Workspace. |
| MTA-STS, TLS-RPT | Hosted via PowerDMARC, policy id 2025-05-27 | Present; encryption in transit enforced. |
| BIMI | Hosted logo via PowerDMARC | Present. Gmail shows the logo only with a VMC certificate; without one it does no harm. |

What `p=reject` means for this build: every message must be DKIM-signed by SendGrid under `cleverdeals.net` or it is thrown away by Gmail, Outlook and Yahoo. That holds as long as the From address stays on `cleverdeals.net` and SendGrid's domain authentication stays verified. Never send from another domain through this SendGrid account's default settings, and treat a DKIM failure alert from PowerDMARC as a stop-sending event.

Two tidy-ups, neither urgent:

1. **Simplify SPF** to `v=spf1 include:_spf.google.com include:sendgrid.net ~all`. The `dnssmarthost` include resolves to an empty `v=spf1 ~all` (a leftover from a previous host) and authorises nothing; `+a` authorises the web server to send mail directly, which nothing should do; `+mx` duplicates the Google include. The shorter record uses 3 lookups and removes an unneeded sender.
2. **Check SendGrid link branding.** No `url…cleverdeals.net` CNAME was found by lookup (SendGrid names it with a number, so it may exist under a name not guessed). If link branding is not set up, every tracked link in every email points at a `sendgrid.net` address, which costs trust and a little reputation. Settings → Sender Authentication → Link Branding in SendGrid shows whether it is verified; the return-path CNAME (`em….cleverdeals.net`) is checked on the same page.

SendGrid account settings to confirm before first send: Subscription Tracking **off** at account level and per send; Click and Open Tracking on; the Event Webhook pointed at the new endpoint with signature verification enabled (a second webhook endpoint if Beagle's account is the same account; otherwise its own); an API key scoped to Mail Send and Suppressions read only.

Mailbox-provider requirements for bulk senders, and where each is met: SPF and DKIM pass (DNS, above); DMARC (above); one-click unsubscribe (pipeline section, phase 1); complaint rate under 0.3% with 0.1% as the working target (nightly job pauses marketing at 0.2%); TLS (MTA-STS, above). Register `cleverdeals.net` in Google Postmaster Tools so the complaint rate Gmail measures is visible; it is the number that matters most and nothing else reports it.

## Build plan

About 20 working days of Claude Code sessions in seven phases, each ending at a gate you can see for yourself before the next starts. Phase 1 is the one that matters: once consent, the gate and the back-in-stock rewrite are in, every later phase is additive and nothing can send to someone who has opted out.

*(Diagram in the original: phases 0–7 as a vertical roadmap, each with a gate: 0 Prepare → four export files in hand; 1 Contacts, consent, gate → one-click unsubscribe works; 2 Import and Bouncer → counts match SendGrid; 3 Sending pipeline → test sends show every event; 4 Campaigns and MCP → first digest approved by MCP; 5 Admin UI → a campaign run without Claude; 6 Automations → cart and reorder sends in test; 7 Cut-over → complaints under 0.1%.)*

Phases run in order; phase 5 (UI) and phase 6 (automations) can swap if you would rather have replenishment reminders before the admin screens, since Claude through MCP covers the operator role until the UI exists.

Claude Code sessions, one or two per phase, in the order to run them:

1. **Schema and gate.** Migrations for the six tables and `customers.contact_id`; backfill a contact for every existing customer; `canSend()` with the class table as a data-driven policy; trigger refusing direct `marketing_status` updates; consent-event writer. Tests: every cell of the class table.
2. **Unsubscribe and preferences pages.** Token generation, one-click POST, GET confirm page, preferences page, storefront header included. Test with a real Gmail one-click.
3. **Back-in-stock on the gate.** Replace the existing sender's SendGrid call with a `email_sends` row of class `transactional`; daily roll-up of multiple requests per contact; one-click add-to-cart link.
4. **Importer.** Streaming CSV parser, normalisation, dry run with report, four list types, idempotency, evidence file storage, import history. Run against the real exports.
5. **Bouncer job.** Verify-on-create, 90-day cache, batch re-verify, result handling.
6. **Sender and webhook.** pg-boss `send_email` job, token bucket, SendGrid client with custom args, categories and headers, retry policy; signed webhook endpoint, event table, state mapping; nightly suppression reconciliation and rate-based auto-pause.
7. **Templates and rendering.** Base layout, block renderer, three-contact preview, text alternative, UTM on every link, deep links.
8. **Weekly digest and new-product roll-up.** Audience builder, per-contact block assembly, empty-digest skip, Wednesday draft job, Thursday send, gap and 48-hour rules.
9. **Manual campaigns, A/B and attribution.** Campaign CRUD, A/B split and winner, order attribution with 5-day click window, campaign report query.
10. **MCP tools.** The `email_` tool set, approval threshold, actor logging; smoke test every tool from a Claude session.
11. **Admin UI.** Seven pages over the service layer; approval queue.
12. **Automations.** Replenishment estimator and job, abandoned cart (needs cart email capture if not already present), welcome series, post-purchase, win-back with batch re-verify, pre-order and subscription hooks, storefront consent box and interest picker.
13. **Cut-over.** Point SendGrid's event webhook at production, run two digests in parallel with the old tool (same audience, the new system holds the truth), compare bounce and complaint figures, cancel the Marketing Campaigns plan.

Each session prompt should be written against this document plus the platform's existing conventions file, the way the storefront build prompts were. Sessions 1–3 should be one continuous piece of work; the rest can be picked up and put down.

## Decisions needed before building

- [ ] Contacts table (recommended) or status fields directly on `customers` with imported unsubscribes as customer records, as the brief says?
- [ ] Confirm the Never Email definition: order-required emails still go, everything else stops.
- [ ] Weekly digest as a cap with empty-digest skip (recommended) or a guaranteed weekly send to everyone?
- [ ] Digest day and time: Thursday 10:00 UK proposed.
- [ ] Discount policy: are discount codes allowed in abandoned-cart step 3, welcome day 10 and win-back day 240? If so, what size?
- [ ] Replenishment defaults: days-to-empty per material for a 1 kg spool (a starting table is fine; the system corrects it from reorder history).
- [ ] Approval threshold for Claude-initiated marketing sends: 50 contacts proposed.
- [ ] Is the SendGrid account shared with Beagle? Decides whether the webhook and API key are new endpoints on the same account or a separate account.
- [ ] Does the SendGrid subscriber export carry list membership by material? Decides whether interests can be populated per row on import or only by a default set.
- [ ] Does the checkout already capture the email before payment (needed for abandoned cart)?
- [ ] Trade segment: is `is_trade` already a customer attribute, or derived from the discount tier?
- [ ] Apply the SPF simplification now, and check link branding in SendGrid (five minutes, both reversible).
- [ ] Phase order: UI before automations, or automations first with Claude as the only operator until the UI lands?
