# New Filament Store — Technical Specification & Project Definition

Project: Dedicated 3D printer filament e-commerce store (working name: Filament Shop) Owner: Roger Butterworth, CleverDeals.Net Document status: Brainstorm consolidated into project definition — v1.2, July 2026 (v1.1: Mollie. v1.2/v1.3: terminology standardised on "inbound shipments" — generic across sea/air/road/courier; multi-format tracking fields added to schema; §14 sales-agent tool schema added. v1.4: §15 discount architecture; £-not-% rule §15.1a. v1.5: §16 payment methods & timing; open Q1 settled. v1.5.1: §16.2a honest cash-flow framing. v1.6: §17 approval queue UX) Dev site: <https://filament.shop.cleverdeals.net/> (unfinished, small dev server, "bones are good") Backend base: Fork of smmta-next — <https://github.com/roger296/smmta-next>

Purpose of this document: Complete context capture from design discussions between Roger and Claude. It is written so that a fresh Claude instance (or any collaborator) can continue the conversation, design work, or implementation with no prior context. All decisions marked \[DECIDED\] are settled; items marked \[OPEN\] need further discussion.

## 1\. Business background and rationale for the pivot

CleverDeals.Net launched \~mid-2025 as a membership-based platform intended to let social media influencers monetise their followings — a Kickstarter-like model where influencers assemble "deals" (group buys / pre-sales) and followers commit to them. CleverDeals handles importing, manufacturing liaison, fulfilment, and customer service on a commission model.

What actually happened: influencer recruitment failed (poor response to outreach; zero influencer signups), but the site sold a meaningful volume of 3D printer filament, driven by traditional PPC/PPM marketing rather than influencer traffic.

The pivot \[DECIDED\]: double down on the discovered niche. Build a dedicated traditional e-commerce store selling 3D printer filament, using a bespoke fork of smmta-next as the backend.

Strategic insight that shapes the whole design: the pre-order and group-buy features planned for the new store are the original CleverDeals model reborn in a market that has already validated demand. "Commit early, wait longer, pay less" against stock on inbound shipments (typically sea freight) gives the business a decisive cash-flow advantage: customers pre-finance inventory, inverting the importer's usual working-capital problem. The store should be designed around this mechanic, not with it bolted on.

### Operating context

Solo operator. Pick/pack labour is Roger's own, \~2–3 hours/day capacity; labour cost treated as zero until volume outgrows this \[DECIDED\].

Roger is technically capable: Docker, Linux, server admin, n8n automation, home lab, TypeScript-adjacent.

Existing infra relationships: Liquid Web for VPS hosting \[DECIDED\], SendGrid for email \[DECIDED\], PayPal account active, Luca's General Ledger (Roger's own open-source accounting app) for the books.

Related asset: contact at 3dpprofessor.com (potential pilot partner for creator colourways).

Roger is building a YouTube channel (currently construction-focused for his Mow Cop project) — content marketing capability exists in-house.

## 2\. Base platform: smmta-next

Repo: <https://github.com/roger296/smmta-next> — "Stock control & order handling module (TypeScript/PostgreSQL) with Luca GL integration."

Known architecture (from repo):

TypeScript monorepo

API: Fastify + Drizzle ORM + PostgreSQL

Storefront: Next.js 15

Admin: Vite/React SPA

Deployment: single-tenant VPS; Docker Postgres; nginx + certbot; systemd units per app; single-shot install.sh installer (fresh-VPS bootstrap — this doubles as the disaster-recovery plan)

Integration: Luca General Ledger for accounting

Already handled by smmta-next — do not redesign \[DECIDED\]: inventory tracking, order tracking, inventory allocation to orders.

The new store is a fork of smmta-next with bespoke features added.

### Current store model (baseline, already built)

Traditional e-com: individual items, basket + checkout, in-stock-only ordering, warehouse stock tracked, fixed per-item prices.

## 3\. Commercial feature set

### F1. Pre-orders against inbound shipments \[DECIDED — strategic core\]

Customers order stock that is in transit from suppliers — typically by sea, but the mechanic is mode-agnostic (sea / air / road / rail / courier) — at a reduced price, accepting longer delivery. Terminology throughout: "inbound shipment", never "container" (a container is one sea-mode instance).

Design points:

Inventory becomes stock pools per SKU: in\_warehouse, in\_transit (per inbound-shipment entity with mode, ETA + SKU manifest), on\_order (with supplier).

Customers buy against unallocated in-transit stock; discount scaled to ETA distance.

Hold back a 5–10% buffer per inbound shipment against damage, customs delay, short-shipment.

\[DECIDED — see §16\] Charge at order. Orders with any line \>30 days to ETA are bank-payment-only (Mollie Pay by Bank / manual transfer): no card fees, no chargeback exposure. Trust replaced via cancel-anytime-before-dispatch promise + explicit pre-order terms.

UK distance selling: 14-day cancellation right applies regardless — build self-service cancellation, don't fight it.

### F2. Master carton pricing \[DECIDED\]

Volume discount for full master cartons. Justified by real cost savings (no de-cartoning, one pick, one label, less packaging). Implement as quantity-tiered pricing at the carton multiple on the same SKU — not a separate SKU — so stock counts stay unified.

### F3. Stacking discounts \[DECIDED\]

F1 + F2 combine: a full carton pre-ordered off an inbound shipment is the best-price tier. Natural buyers: print farms (see B2B, §5).

### F4. Subscriptions \[DECIDED\]

Regular deliveries with the deepest discounts. Avoid rigid "1 roll of black PLA monthly" — filament usage is lumpy and colour needs vary, so rigid subs churn badly. Preferred models:

Flexible credit allowance: monthly credit at a discount, skip/swap/pause freely.

Smart replenishment: predict run-out from purchase cadence; prompt rather than auto-ship.

Mechanics via Mollie recurring mandates \[DECIDED — corrected from earlier Stripe assumption\]: customer's first payment establishes a mandate; the worker's subscription-renewal-scan job charges the mandate on-demand each cycle. This suits the flexible credit/skip/swap model better than fixed-interval subscription products. Dunning/retries are ours (worker job, e.g. day 1/3/5 then pause). Differentiation lives in the flexibility layer built on top.

### F5. AI sales agent in the purchase flow \[DECIDED\]

Chat-based sales assistant helping users build baskets, delivered via OpenRouter.

Architecture (critical): tool-calling agent that can only act through backend functions. The model never states a price, ETA, or stock figure from its own weights — everything comes from the API. All basket mutations happen server-side through the same validated service functions the storefront buttons use. This structurally prevents hallucinated discounts/prices.

Minimum tool schema:

search\_catalogue

get\_stock\_and\_eta

quote\_price (handles carton tiers, pre-order discounts, stacking)

add\_to\_basket / basket mutations

apply\_discount\_check

get\_customer\_interests (see F8 — gives the agent salesperson memory: "you're watching matte black PETG; it's on the inbound shipment due 14 Aug, pre-order saves £3 a roll")

Chat is a Fastify route; storefront connects via SSE streaming; conversation state in a Postgres table keyed by session (storefront stays stateless).

### F6. Proactive notification agent \[DECIDED — reframed\]

Not a free-running agent. An event-driven notification system with AI as the composition layer:

Boring reliable code detects events (scheduled jobs comparing carrier/supplier ETAs and stock positions against promised dates; allocation shortfalls).

Each event triggers an LLM job that drafts a personalised customer message with options (wait / swap to in-stock alternative at the pre-order price / refund).

Drafts land in a human approval queue in the admin SPA (approve/edit/reject from phone). Auto-send is enabled per event type only after trust is established. Rationale: reputational cost of one hallucinated apology email is high.

### F7. AI marketing agent \[DECIDED\]

Same machinery on a nightly cron:

Segmentation = plain SQL over order history (run-out prediction — e.g. "buys 4 rolls PETG every \~6 weeks", lapsed buyers, subscription upsell candidates, interest-flag watchers).

LLM composes personalised offers per selected customer.

Same approval queue, same sender pipeline.

Frequency caps baked in — the agent must not be able to decide someone needs five emails a week.

PECR/GDPR: explicit marketing consent, clean unsubscribe (see §7).

### F8. Interest flags / demand signal registry \[DECIDED — added in discussion, high strategic value\]

One button whose meaning is contextual, all writing to a single interest\_flags table and emitting domain events:

| Context | Button meaning | Behaviour |
| :-: | :-: | :-: |
| Out of stock | "Notify me when it's back" | Back-in-stock alert (typically converts 15–25% — best email the store will send) |
| In stock | "Watch for offers" | Price-drop / deal alerts; explicit permission for targeted offers |
| Not yet ranged ("coming soon" catalogue of products under consideration) | "Register interest" | Threshold of flags triggers inclusion on next inbound shipment / purchase order |

Why it matters: it de-risks inbound purchasing. Every inbound-shipment manifest becomes a data-driven decision ("43 watching matte black PETG, 6 watching purple silk") made before committing money. It is the group-buy DNA applied with a lighter commitment than paid pre-order.

Extensions:

Threshold-triggered group buys, made visible: "Carbon-fibre nylon — 27 of 40 interested, ships when we hit 40." Progress bar = social proof + shareable link.

Priced signal strength \[OPEN\]: optional refundable £1–5 deposit ("lock in launch pricing") that becomes purchase credit. Deposit-backed interest converts at several times the free-flag rate and stratifies demand into curious vs. committed when sizing inbound purchase orders.

Creator colourway validation: the register-interest page is the campaign page (see §5).

### F9. Frictionless signup \[DECIDED\]

Lightest tier: email-only ("watch this product" → type email → done; implicit guest account).

Social login: Google first (audience skews technical/Google-logged-in), Facebook second, Apple only if mobile traffic later justifies it.

Implementation: Auth.js (NextAuth) in the Next.js storefront with Drizzle adapter — identities land in the same Postgres; no external auth service.

Schema decision (day one): separate the person from login methods — users table + linked auth\_identities table; merge on verified email so one human ≠ three records. Marketing-agent segmentation quality depends on this.

Consent capture: two separate flags — (a) "updates about things I've flagged" (implicit in the action), (b) "general offers and news" (unticked checkbox). Never conflate; protects both compliance and the signal value of the flag channel.

Caution: signup-OAuth and Facebook pixel/ad-audience tracking are separate decisions; the latter drags in extra GDPR consent requirements. Do not drift from one into the other.

## 4\. Technical architecture

### Guiding principle

Extend, don't add. Boring infrastructure; the interesting work lives in application code. One VPS runs everything for a long time at filament volumes.

### 4.1 Monorepo layout

Existing smmta-next apps plus one new app:

apps/

api/ Fastify + Drizzle + Postgres (existing; gains chat route, auth, webhooks)

storefront/ Next.js 15 (existing; gains chat UI, interest flags, Auth.js)

admin/ Vite/React SPA (existing; gains approval queue UI, agent digest)

worker/ NEW — background jobs, agents (pg-boss consumer, systemd unit)

### 4.2 Job queue: pg-boss \[DECIDED\]

pg-boss, not BullMQ. BullMQ requires Redis (another container, failure mode, backup target). pg-boss runs the queue inside the existing Postgres; provides cron scheduling, retries with backoff, dead-letter handling. Volumes here are hundreds of jobs/day — Postgres won't notice. Bonus: a single pg\_dump captures orders, stock, and pending jobs — whole-system state in one backup.

### 4.3 Domain events (outbox pattern) \[DECIDED — architectural backbone\]

Whenever the API does something interesting, it writes an event row in the same transaction as the change. The worker consumes events and reacts. This one pattern powers F6, F7, half of F4, and F8.

Event sources include: shipment ETA updated, stock allocation broken, order dispatched, subscription renewal due, interest flag created, interest threshold crossed, price changed, inbound shipment arrived, Mollie webhook received, SendGrid webhook received.

### 4.4 AI agents

| Agent | Lives in | Trigger | Output path |
| :-: | :-: | :-: | :-: |
| Sales agent (F5) | api chat route (SSE) | User opens chat | Direct tool calls into service layer |
| Notification agent (F6) | worker | Domain events + scheduled ETA/stock comparison jobs | LLM draft → approval queue → send job |
| Marketing agent (F7) | worker | Nightly cron | Segmentation SQL → LLM draft per customer → approval queue → send job |

Agent tools are direct calls into the existing service layer (same functions the REST routes use) — not HTTP round-trips to self. Guarantees validation parity with the UI and makes hallucinated prices structurally impossible.

Do not use n8n for the marketing agent — it would split business logic across two systems and lose type-safe Drizzle schema access. n8n remains for external glue (e.g. existing influencer outreach flows).

### 4.5 OpenRouter integration \[DECIDED\]

Single internal wrapper module used by api + worker:

Default model: cheap/fast class (Haiku-class or Gemini-Flash-class) — sufficient for basket assistance and email drafting.

Model fallback configured: provider outage degrades, doesn't break.

Per-day spend cap.

Every request/response logged to a Postgres table — audit trail of what agents said; later becomes the prompt-improvement dataset.

### 4.6 Email: SendGrid \[DECIDED\]

Authenticate a dedicated subdomain (e.g. mail.filament.cleverdeals.net) with its own DKIM/SPF.

Separate transactional and marketing streams (SendGrid subusers or at minimum separate sender identities/IPs) — order confirmations must never share reputation with promotions.

SendGrid event webhook (bounces, spam reports, unsubscribes) flows back into the API and updates a local suppression/consent table.

Postgres is the single source of truth for who is contactable (this is also the PECR compliance record); SendGrid is a dumb pipe.

Never send from raw VPS SMTP (deliverability from fresh IPs is hopeless).

### 4.7 Payments \[DECIDED: Mollie\]

Mollie is the payment spine (existing provider). One-off checkout via Mollie Payments API; methods: cards, Apple Pay, PayPal, plus iDEAL/Bancontact/Klarna if selling into the EU.

Subscriptions (F4) via Mollie recurring mandates: first payment (sequenceType=first) establishes the mandate; the worker charges it on-demand (sequenceType=recurring) per the customer's plan. The billing schedule and dunning live in our worker, not the PSP — subscription-renewal-scan initiates charges; a payment-retry job handles failures (day 1/3/5, then pause subscription + compose a personal-tone message).

Mollie webhooks are thin: they deliver only a resource ID; the API handler fetches the payment/mandate state from Mollie, then normalises to domain events (per §12.1 rule 4). Respond 200 fast; fetch-and-process async.

Store mollie\_customer\_id + mollie\_mandate\_id per user/subscription (see §13.7).

PayPal as secondary checkout button (account exists; Mollie can also route PayPal — consolidate later if useful).

### 4.8 Auth

Auth.js (NextAuth) + Drizzle adapter, Google OAuth first, email magic-link/lightweight tier, Facebook second. See F9 for the users/auth\_identities split and merge-on-verified-email rule.

## 5\. Additional revenue ideas (brainstormed, prioritised)

Own-brand filament \[high priority, runs in parallel — supply-side project independent of software\]. Already importing in bulk (sea freight); white-labelling from a Chinese extruder (custom branding at modest MOQs) roughly doubles margin vs. reselling and makes subscription/pre-order tiers defensible (no direct price comparison on your SKU).

Creator colourways \[salvages the influencer thesis\]. Limited-edition influencer-branded colours sold as threshold pre-orders. Register-interest page = campaign page; influencer shares it; factory briefed only when threshold clears. Near-zero inventory risk; commission to influencer; flag count is the pitch to the next influencer. Pilot candidate: 3dpprofessor contact.

B2B trade accounts for print farms. VAT invoicing, credit terms, standing carton orders. Natural buyers of the best-price tier; very low churn.

Sample/swatch packs. Low-cost acquisition product; feeder into subscriptions.

Adjacent consumables (nozzles, desiccant, dry-box supplies) — previously explored expansion; filament orders are the vehicle (shipping already paid).

Refill coils + spool-return loyalty scheme (eco angle).

Community group buys on exotic materials — threshold mechanic from F8.

Content/SEO moats: per-printer print profiles; honest per-kilogram price comparisons. Cheap to produce (YouTube capability in-house), valuable in an obsessive-researcher market.

## 6\. Hosting, ops, and costs

### Production \[DECIDED: Liquid Web\]

One VPS, \~4 vCPU / 8 GB / NVMe. Hosts Postgres (Docker), api, storefront, admin, worker. AI inference happens at OpenRouter's end — local load is web serving + Postgres.

nginx + certbot as per smmta-next installer; systemd unit per app; extend install.sh to add the worker unit (preserves "one script, fresh VPS" = disaster-recovery plan).

Hardening: UFW locked to 80/443/SSH, SSH keys only, fail2ban.

### Staging: Roger's home lab

Docker compose stack mirroring production. Test migrations; let agents run against fake customers before touching real ones.

Uptime Kuma on home lab pointed at production (free external monitoring).

### Backups

Nightly pg\_dump shipped off-box (Backblaze B2 or S3, pennies/month) + uploads directory if images stored locally.

Because pg-boss and the event log live in Postgres, one backup captures everything.

Test a restore before launch.

### Observability

Fastify's native pino structured JSON logs → journald.

Sentry free tier (api + worker) for error alerts.

Daily "agent digest" email to Roger: what agents sent, what awaits approval, what failed. For a solo operator this beats any dashboard.

### Scale-out fault lines (not needed for years, but pre-planned)

Worker → second VPS if LLM composition jobs ever contend with web traffic.

Postgres → managed hosting if backups/failover eat time. Separate systemd units from day one keep both moves cheap.

### Estimated monthly run cost

| Item | Est. |
| :-: | :-: |
| Liquid Web VPS | £25–40 |
| SendGrid | £10–15 at launch volumes |
| OpenRouter | £10–30 (composition tiny; chat is the variable) |
| Backups (B2/S3) | \~£1 |
| Mollie/PayPal | per-transaction only |
| Total | \~£50–90/month (≈ one master carton sale) |

## 7\. Compliance notes (UK)

PECR/GDPR: explicit consent for general marketing (unticked checkbox); interest-flag updates are a distinct, narrower consent. Suppression/consent table in own Postgres = compliance record. Clean unsubscribe everywhere. Frequency caps enforced in code, not policy.

Distance selling: 14-day cancellation right applies to pre-orders; provide self-service cancellation.

Facebook tracking ≠ Facebook login: building ad audiences from interest data requires additional consent — separate decision, deliberately deferred.

## 8\. New data model additions (outline)

Additions to the smmta-next schema (Drizzle/Postgres). Names indicative:

users — the person (canonical customer record)

auth\_identities — login methods, FK → users; merge on verified email

consent\_records — per-user consent type, timestamp, source (PECR record)

interest\_flags — user, SKU or prospective-SKU, flag type (restock / offers / register-interest), timestamp, source page

prospective\_products — the "coming soon" catalogue; interest thresholds

inbound\_shipments (+ lines) — mode, carrier, ETA, status, multi-format tracking refs, SKU manifest, buffer %; in-transit stock pool

domain\_events — outbox table (type, payload, created\_at, processed\_at)

chat\_sessions / chat\_messages — sales-agent conversation state

llm\_log — every OpenRouter request/response (audit + future prompt tuning)

message\_drafts / approval queue — agent output awaiting human approve/edit/reject

suppression\_list — fed by SendGrid webhooks

subscriptions — Mollie customer/mandate refs + flexibility layer (credits, skip/swap/pause); billing schedule is worker-driven

(Existing smmta-next tables for inventory, orders, and allocation are reused untouched.)

## 9\. Build sequence \[DECIDED\]

apps/worker + pg-boss + domain\_events table (\~2 days to establish; backbone for everything).

Mollie checkout + webhooks → events (incl. thin-webhook fetch pattern).

Chat route + minimal sales agent (3–4 tools: search, stock/ETA, quote, add-to-basket).

Approval queue in admin SPA.

Notification jobs (F6) and marketing jobs (F7) on top.

Carton pricing (F2) is trivial and can slot in early for immediate AOV lift; pre-order/inbound-shipment system (F1) follows as the strategic core; subscriptions (F4) after.

Own-brand sourcing runs in parallel (supply-side, software-independent).

## 10\. Open questions \[OPEN\]

Charge at order or dispatch — settled: charge at order, all order types; \>30-day orders are bank-payment-only (Pay by Bank / manual transfer). See §16.

Refundable deposit tier for interest flags — include at launch or phase 2?

Discount curve for pre-orders — structure decided (§15); band %s and floor contribution % to be calibrated against real landed costs.

Subscription model: credit-bonus mechanism decided (§15.4); remaining choice is replenishment UX (prompted vs. auto) on top of credits.

Which OpenRouter models specifically (test cheap-class options for chat quality)?

SendGrid subuser split — confirm plan tier supports it.

Domain/branding for the new store (currently filament.shop.cleverdeals.net — keep subdomain or new brand, especially if own-brand filament launches?).

Own-brand supplier shortlist and MOQ research.

Creator colourway pilot terms with 3dpprofessor contact.

Dunning schedule tuning (day 1/3/5 is a starting assumption) and whether to use Mollie's fixed Subscriptions API for any simple plan tiers vs. mandate-only for all.

## 11\. Immediate next design tasks

Build execution: a companion document, claude code build prompts.md (Prompts G, 0–16), turns this spec into a sequential Claude Code build plan with per-step test gates. Place both files in the repo under docs/ before starting the session.

Drizzle table definitions — done, see §13.

Full domain-event taxonomy + pg-boss job catalogue — done, see §12.

Tool schema (JSON) for the sales agent — done, see §14.

Pre-order pricing/discount curve model — done, see §15.

Approval-queue UX sketch — done, see §17.

## 12\. Domain-event taxonomy & pg-boss job catalogue \[DECIDED — designed July 2026\]

### 12.1 Design rules

Events are past-tense facts, never commands. (shipment.eta\_changed, not notify\_customers.) Events record what happened; jobs decide reactions. API stays dumb; reactions change without touching commerce code.

Single dispatcher, many handlers. The API only writes domain\_events rows (same transaction as the business change). One outbox-dispatcher job polls for unprocessed events and fans out to typed handler jobs. The API never enqueues jobs directly — preserves the transactional guarantee.

Detection jobs emit events too. Conditions no single API call causes (ETA slipping past a promise, stale basket) are found by scheduled scan jobs which emit events into the same table. Reaction pipeline is uniform regardless of trigger origin.

Provider webhooks are normalised at the API boundary. Mollie/SendGrid payloads are translated into domain events; provider-specific shapes never reach the worker. (Mollie webhooks carry only a resource ID — the handler fetches full state from the Mollie API before emitting the event.)

Enforcement at the choke point. Frequency caps and suppression checks live in send-message (last gate before SendGrid), not in agent logic — no upstream code, human, or LLM can breach them.

### 12.2 Event taxonomy

Commerce | Event | Emitted by | Payload (key fields) | |---|---|---| | order.placed | checkout | order\_id, user\_id, lines, pool (warehouse/pre-order) | | order.paid | Mollie webhook (fetch → paid) | order\_id, payment\_ref | | order.dispatched | admin/fulfilment | order\_id, carrier, tracking | | order.cancelled | user self-service / admin | order\_id, reason | | order.refunded | Mollie webhook / admin | order\_id, amount | | basket.abandoned | basket-abandonment-scan | session/user\_id, basket snapshot |

Inbound shipments | Event | Emitted by | Payload | |---|---|---| | shipment.created | admin | shipment\_id, mode, manifest, eta, buffer\_pct | | shipment.eta\_changed | admin / carrier-data job | shipment\_id, old\_eta, new\_eta | | shipment.arrived | admin | shipment\_id, actual\_date | | shipment.short\_shipped | goods-in reconciliation | shipment\_id, manifest variance |

Stock & pricing | Event | Emitted by | Payload | |---|---|---| | stock.replenished | goods-in / allocation release | sku, qty, pool | | stock.allocation\_broken | allocation engine / stock-watch | sku, affected order\_ids, shortfall | | price.changed | admin | sku, old, new |

Interest / demand signals | Event | Emitted by | Payload | |---|---|---| | interest.flag\_created | storefront | user\_id, sku or prospective\_id, flag\_type | | interest.threshold\_crossed | threshold-check | prospective\_id, count, threshold | | interest.deposit\_paid | Mollie webhook | user\_id, prospective\_id, amount |

Customers / consent | Event | Emitted by | Payload | |---|---|---| | user.created | Auth.js / guest capture | user\_id, source | | user.merged | identity merge on verified email | surviving\_id, merged\_id | | consent.granted / consent.revoked | storefront / unsubscribe | user\_id, consent\_type, source | | suppression.updated | SendGrid webhook | email, reason (bounce/complaint/unsub) |

Subscriptions | Event | Emitted by | Payload | |---|---|---| | subscription.created / .cancelled | storefront (mandate established) / user | sub\_id, user\_id, plan | | subscription.renewal\_upcoming | subscription-renewal-scan | sub\_id, renewal\_date | | subscription.payment\_failed | Mollie webhook on recurring charge | sub\_id, attempt | | subscription.modified | storefront (skip/swap/pause) | sub\_id, change |

Messaging / agents | Event | Emitted by | Payload | |---|---|---| | draft.created | compose-message | draft\_id, trigger\_event\_id, user\_id | | draft.approved / draft.rejected | admin SPA | draft\_id, editor\_notes | | message.sent / message.failed | send-message | draft\_id, sendgrid\_msg\_id / error |

### 12.3 Job catalogue

Scheduled scanners (pg-boss cron) | Job | Schedule | Does | |---|---|---| | eta-watch | daily | Compares shipment ETAs vs outstanding order promise dates → emits shipment.eta\_changed consequences per affected order (F6 workhorse) | | stock-watch | hourly | Detects allocation shortfalls & back-in-stock transitions → events | | run-out-prediction | nightly | Recomputes per-customer consumable cadence (feeds F7 segmentation) | | marketing-nightly | nightly | Segmentation SQL → enqueues compose-message per selected customer | | basket-abandonment-scan | hourly | Stale baskets → basket.abandoned | | subscription-renewal-scan | daily | Upcoming renewals → reminder pipeline; initiates Mollie mandate charges due today | | agent-digest | daily 07:00 | Email to Roger: sent / awaiting approval / failed | | outbox-dispatcher | every \~10s (or LISTEN/NOTIFY later) | Fans unprocessed domain\_events out to handlers |

Event-driven handlers | Job | Triggered by | Does | |---|---|---| | compose-message | notification-worthy events; marketing segmentation | One LLM call per customer-message via OpenRouter wrapper → writes to approval queue (draft.created). Per-message granularity: retries isolated, model failure can't stall queue | | send-message | draft.approved (or auto-approved event types) | Checks suppression + frequency cap at send time, dispatches via SendGrid, records message.sent/failed | | back-in-stock-fanout | stock.replenished | Enqueues compose/send for every watcher of that SKU | | threshold-check | interest.flag\_created | Counts flags for prospective SKU; emits interest.threshold\_crossed; notifies Roger for supplier quote | | identity-merge | user.created with matching verified email | Merges records, emits user.merged |

Retry policy: pg-boss defaults with exponential backoff; payment-retry (dunning we own under Mollie): re-attempt mandate charge day 1/3/5 after subscription.payment\_failed, then set subscription past\_due→paused and compose message; compose-message max 3 retries then dead-letter (digest surfaces dead-letters); send-message max 5 retries (SendGrid transient errors) with idempotency key = draft\_id to prevent double-sends.

### 12.4 Event → reaction map (initial)

| Event | Reaction |
| :-: | :-: |
| shipment.eta\_changed (worse, affects promises) | compose-message per affected pre-order customer with options: wait / swap to in-stock at pre-order price / refund |
| shipment.arrived | Fulfilment notice to pre-order customers; pre-order pricing window closes for that stock |
| stock.replenished | back-in-stock-fanout to restock watchers |
| price.changed (down) | Compose offers to "watch for offers" flaggers |
| interest.threshold\_crossed | Notify Roger; optionally open group-buy page state |
| subscription.payment\_failed | payment-retry job (day 1/3/5); day-3 personal-tone compose; pause after final failure |
| basket.abandoned | Single reminder (marketing consent required) |
| consent.revoked / suppression.updated | Update suppression table; cancel queued drafts for that user |

(Auto-send graduation: each event type starts in approval-required mode; flipped to auto-send individually once trusted — per F6.)

## 13\. Drizzle schema definitions \[DECIDED — designed July 2026\]

### 13.1 What Drizzle is (context for readers unfamiliar)

Drizzle is the TypeScript ORM already used by smmta-next. Tables are defined once in TypeScript; drizzle-kit diffs those definitions against the live database and generates versioned SQL migrations (committed to git — schema is version-controlled and install.sh replays migrations on a fresh VPS). Queries are compile-time type-checked against the schema. Drizzle is deliberately thin — queries read like SQL, and raw SQL (used for marketing segmentation, run-out prediction) returns typed results. The definitions below are simultaneously design documentation and near-paste-ready code for packages/db/schema/ in the fork.

Conventions: uuid PKs (defaultRandom()), snake\_case column names, timestamptz via timestamp(..., { withTimezone: true }) (abbreviated below), money as integer pence, enums as text with enum option (cheap to extend vs pg enums). Align final naming with existing smmta-next schema conventions on implementation.

### 13.2 Identity & consent

export const users = pgTable('users', {

id: uuid('id').primaryKey().defaultRandom(),

email: text('email').unique(),

emailVerified: timestamp('email\_verified'), // merge-on-verified-email keys off this

displayName: text('display\_name'),

kind: text('kind', { enum: \['guest', 'account', 'trade'\] }).notNull().default('guest'),

mergedInto: uuid('merged\_into'), // set on losing record after identity merge

createdAt: timestamp('created\_at').defaultNow().notNull(),

});

export const authIdentities = pgTable('auth\_identities', {

id: uuid('id').primaryKey().defaultRandom(),

userId: uuid('user\_id').notNull().references(() =\> users.id),

provider: text('provider', { enum: \['google', 'facebook', 'email'\] }).notNull(),

providerAccountId: text('provider\_account\_id').notNull(),

createdAt: timestamp('created\_at').defaultNow().notNull(),

}, (t) =\> \[uniqueIndex('uq\_provider\_account').on(t.provider, t.providerAccountId)\]);

// APPEND-ONLY. Current consent = latest row per (user, type).

// This is the PECR evidence trail; never UPDATE or DELETE.

export const consentRecords = pgTable('consent\_records', {

id: uuid('id').primaryKey().defaultRandom(),

userId: uuid('user\_id').notNull().references(() =\> users.id),

consentType: text('consent\_type', {

enum: \['flag\_updates', 'general\_marketing'\] }).notNull(),

granted: boolean('granted').notNull(), // false row = revocation

source: text('source').notNull(), // page/action that captured it

createdAt: timestamp('created\_at').defaultNow().notNull(),

});

// Mutable fast-path cache: "can I email this address right now".

// Fed by SendGrid webhooks + consent revocations. Checked by send-message.

export const suppressionList = pgTable('suppression\_list', {

email: text('email').primaryKey(),

reason: text('reason', { enum: \['bounce', 'complaint', 'unsubscribe', 'manual'\] }).notNull(),

updatedAt: timestamp('updated\_at').defaultNow().notNull(),

});

### 13.3 Interest & prospective products

export const prospectiveProducts = pgTable('prospective\_products', {

id: uuid('id').primaryKey().defaultRandom(),

name: text('name').notNull(),

description: text('description'),

status: text('status', {

enum: \['considering', 'group\_buy\_open', 'ordered', 'ranged', 'abandoned'\] })

.notNull().default('considering'),

interestThreshold: integer('interest\_threshold'), // flags needed to trigger action

depositPence: integer('deposit\_pence'), // optional refundable deposit tier \[OPEN\]

creatorPartner: text('creator\_partner'), // colourway campaigns

createdAt: timestamp('created\_at').defaultNow().notNull(),

});

export const interestFlags = pgTable('interest\_flags', {

id: uuid('id').primaryKey().defaultRandom(),

userId: uuid('user\_id').notNull().references(() =\> users.id),

sku: text('sku'), // set for ranged products

prospectiveId: uuid('prospective\_id').references(() =\> prospectiveProducts.id),

flagType: text('flag\_type', {

enum: \['restock', 'offers', 'register\_interest'\] }).notNull(),

depositPaidPence: integer('deposit\_paid\_pence'), // stratifies curious vs committed

sourcePage: text('source\_page'),

createdAt: timestamp('created\_at').defaultNow().notNull(),

clearedAt: timestamp('cleared\_at'), // notified / converted / cancelled

}, (t) =\> \[uniqueIndex('uq\_flag').on(t.userId, t.sku, t.prospectiveId, t.flagType)\]);

### 13.4 Inbound shipments (pre-order stock pools)

Mode-agnostic: one table covers a sea container, an air-freight consignment, a pallet by road, or a courier parcel. Tracking references vary wildly by mode and carrier (container number, bill of lading, AWB, courier tracking code, vessel/voyage, PO number...), so the design pairs a few typed common fields with a tracking\_refs jsonb array that stores any number of references in any format, each optionally with a tracking URL.

export const inboundShipments = pgTable('inbound\_shipments', {

id: uuid('id').primaryKey().defaultRandom(),

reference: text('reference').notNull(), // our internal ref (human-friendly)

mode: text('mode', {

enum: \['sea', 'air', 'road', 'rail', 'courier'\] }).notNull().default('sea'),

supplier: text('supplier'),

carrier: text('carrier'), // shipping line / airline / courier name

etaOriginal: timestamp('eta\_original').notNull(), // kept for supplier-reliability metrics

eta: timestamp('eta').notNull(), // current

status: text('status', {

enum: \['booked', 'in\_transit', 'at\_port', 'customs', 'received', 'reconciled'\] })

.notNull().default('booked'),

// Multi-format tracking. Array of objects, e.g.:

// \[{ kind: 'container\_no', value: 'MSKU1234567' },

// { kind: 'bill\_of\_lading', value: 'MAEU123456789' },

// { kind: 'awb', value: '176-12345675' },

// { kind: 'courier\_tracking', carrier: 'DPD', value: '05312345678901',

// url: 'https://track.dpd.co.uk/...' },

// { kind: 'vessel', value: 'EVER GIVEN / 0421-005E' },

// { kind: 'supplier\_po', value: 'PO-2026-0042' }\]

// \`kind\` is free text by design — new formats need no migration.

trackingRefs: jsonb('tracking\_refs').notNull().default(sql\`'\[\]'::jsonb\`),

trackingUrl: text('tracking\_url'), // primary "click to track" link for admin UI

notes: text('notes'),

bufferPct: integer('buffer\_pct').notNull().default(8), // held back from presale

arrivedAt: timestamp('arrived\_at'),

createdAt: timestamp('created\_at').defaultNow().notNull(),

});

export const inboundShipmentLines = pgTable('inbound\_shipment\_lines', {

id: uuid('id').primaryKey().defaultRandom(),

shipmentId: uuid('shipment\_id').notNull().references(() =\> inboundShipments.id),

sku: text('sku').notNull(),

qtyManifested: integer('qty\_manifested').notNull(),

qtyReceived: integer('qty\_received'), // set at goods-in; variance → shipment.short\_shipped

qtyPresold: integer('qty\_presold').notNull().default(0), // F1 sells against manifested\*(1-buffer) - presold

}, (t) =\> \[uniqueIndex('uq\_shipment\_sku').on(t.shipmentId, t.sku)\]);



Notes: status value in\_transit replaces the sea-specific at\_sea; at\_port covers seaport or airport. The eta-watch job reads only mode-agnostic fields (eta, status), so F6 works identically for all modes. Future option: per-kind tracking-API integrations (e.g. courier webhooks) can auto-update eta and emit shipment.eta\_changed without schema change.

### 13.5 Events, drafts, messaging

export const domainEvents = pgTable('domain\_events', {

id: uuid('id').primaryKey().defaultRandom(),

eventType: text('event\_type').notNull(), // e.g. 'shipment.eta\_changed' (§12.2)

aggregateType: text('aggregate\_type'), // 'order' | 'shipment' | 'user' | ...

aggregateId: uuid('aggregate\_id'), // → full per-entity event history for debugging

payload: jsonb('payload').notNull(),

createdAt: timestamp('created\_at').defaultNow().notNull(),

processedAt: timestamp('processed\_at'), // set by outbox-dispatcher

}, (t) =\> \[

index('ix\_events\_unprocessed').on(t.createdAt).where(sql\`processed\_at IS NULL\`),

index('ix\_events\_aggregate').on(t.aggregateType, t.aggregateId),

\]);

export const messageDrafts = pgTable('message\_drafts', {

id: uuid('id').primaryKey().defaultRandom(), // doubles as send idempotency key

userId: uuid('user\_id').notNull().references(() =\> users.id),

triggerEventId: uuid('trigger\_event\_id').references(() =\> domainEvents.id), // full traceability

channel: text('channel', { enum: \['email'\] }).notNull().default('email'),

category: text('category', { enum: \['transactional', 'marketing'\] }).notNull(),

subject: text('subject').notNull(),

body: text('body').notNull(),

status: text('status', {

enum: \['pending', 'approved', 'auto\_approved', 'rejected', 'sent', 'failed'\] })

.notNull().default('pending'),

editorNotes: text('editor\_notes'),

sendgridMessageId: text('sendgrid\_message\_id'),

createdAt: timestamp('created\_at').defaultNow().notNull(),

resolvedAt: timestamp('resolved\_at'),

});

### 13.6 Chat & LLM audit

export const chatSessions = pgTable('chat\_sessions', {

id: uuid('id').primaryKey().defaultRandom(),

userId: uuid('user\_id').references(() =\> users.id), // nullable: anonymous browsing

basketId: uuid('basket\_id'), // links agent to live basket

createdAt: timestamp('created\_at').defaultNow().notNull(),

closedAt: timestamp('closed\_at'),

});

export const chatMessages = pgTable('chat\_messages', {

id: uuid('id').primaryKey().defaultRandom(),

sessionId: uuid('session\_id').notNull().references(() =\> chatSessions.id),

role: text('role', { enum: \['user', 'assistant', 'tool'\] }).notNull(),

content: text('content'),

toolCalls: jsonb('tool\_calls'), // session replay shows exactly what agent looked up

toolResults: jsonb('tool\_results'),

createdAt: timestamp('created\_at').defaultNow().notNull(),

});

export const llmLog = pgTable('llm\_log', {

id: uuid('id').primaryKey().defaultRandom(),

purpose: text('purpose', { enum: \['chat', 'compose', 'other'\] }).notNull(),

model: text('model').notNull(),

requestJson: jsonb('request\_json').notNull(),

responseJson: jsonb('response\_json'),

promptTokens: integer('prompt\_tokens'),

completionTokens: integer('completion\_tokens'),

latencyMs: integer('latency\_ms'),

costMicroUsd: integer('cost\_micro\_usd'), // per-day spend cap sums this

createdAt: timestamp('created\_at').defaultNow().notNull(),

});

### 13.7 Subscriptions (Mollie mandates; worker-driven billing)

// Mollie mandate = payment authority. Billing schedule, dunning, and

// product behaviour are OURS (worker-driven). This table is the truth.

export const subscriptions = pgTable('subscriptions', {

id: uuid('id').primaryKey().defaultRandom(),

userId: uuid('user\_id').notNull().references(() =\> users.id),

mollieCustomerId: text('mollie\_customer\_id').notNull(),

mollieMandateId: text('mollie\_mandate\_id'), // set once first payment clears

plan: text('plan').notNull(),

status: text('status', {

enum: \['active', 'past\_due', 'paused', 'cancelled'\] }).notNull(),

creditBalancePence: integer('credit\_balance\_pence').notNull().default(0),

renewsAt: timestamp('renews\_at'),

createdAt: timestamp('created\_at').defaultNow().notNull(),

});

export const subscriptionEvents = pgTable('subscription\_events', {

id: uuid('id').primaryKey().defaultRandom(),

subscriptionId: uuid('subscription\_id').notNull().references(() =\> subscriptions.id),

kind: text('kind', { enum: \['skip', 'swap', 'pause', 'resume', 'credit\_spend', 'credit\_grant'\] }).notNull(),

detail: jsonb('detail'),

createdAt: timestamp('created\_at').defaultNow().notNull(),

});

### 13.8 Schema design decisions (summary)

Consent append-only; suppression mutable. History for PECR evidence; cache for the send-time check.

Guest tier = users row with no auth\_identities row. Email-only watching is free; identity merge keys on verified email and sets merged\_into on the losing record (never delete — order history FKs survive).

domain\_events carries aggregate pointers → per-entity event history for support/debugging at zero extra cost. Partial index on unprocessed rows keeps dispatcher polling O(pending).

message\_drafts.id is the send idempotency key; trigger\_event\_id makes every email traceable to its cause.

Pre-order availability formula: qty\_manifested × (1 − buffer\_pct/100) − qty\_presold, computed per shipment line.

Money in integer pence; LLM cost in micro-USD — no floats near money.

Existing smmta-next tables (inventory, orders, allocation) untouched; new tables reference them by SKU/order id per existing conventions.

## 14\. Sales agent tool schema \[DECIDED — designed July 2026\]

### 14.1 Contract-level design rules

Identity is server-injected. No tool accepts user\_id, session\_id, or basket\_id. The Fastify chat route resolves these from the authenticated session and supplies them when executing tool calls. Cross-customer access is structurally impossible regardless of prompt injection.

Reads are free; writes echo state. Read tools are side-effect-free and callable liberally. Every mutating tool returns the complete post-mutation state (full basket / flag list) — the model never infers state from memory.

Prices exist only inside quote\_price. Search returns display prices for conversational colour only; commitments require a quote. add\_to\_basket re-prices server-side regardless, so a skipped quote cannot corrupt an order.

Stock is banded (in\_stock/low\_stock/out\_of\_stock) — exact warehouse counts are neither needed nor conversationally extractable. Exception: presale availability per inbound shipment IS exact (customers need it; scarcity legitimately sells).

Uniform result envelope: { ok: true, data } | { ok: false, error: { code, message } }. Fixed error codes; the system prompt maps codes to sales behaviour (INSUFFICIENT\_STOCK → offer inbound pool or interest flag; LOGIN\_REQUIRED → invite sign-in).

Budgets: max tool calls per assistant turn (e.g. 8) and per session (e.g. 60); per-session token/spend cap via the OpenRouter wrapper (§4.5). Exceeding → graceful wind-down message.

Tools are direct service-layer calls (§4.4); the JSON below is the OpenRouter-facing contract only.

### 14.2 Error codes

INVALID\_SKU · INSUFFICIENT\_STOCK · POOL\_UNAVAILABLE · LINE\_NOT\_FOUND · LOGIN\_REQUIRED · CONSENT\_REQUIRED · INVALID\_CODE · RATE\_LIMITED · INTERNAL (never surfaces provider/internal detail to the model)

### 14.3 Tool definitions (OpenRouter function-calling format)

\[

{

"name": "search\_catalogue",

"description": "Search ranged products. Returns up to \`limit\` matches with sku, name, material, colour, diameter, display\_price (INDICATIVE ONLY — call quote\_price before stating any price as a commitment), and stock\_band. Also returns matching prospective\_products (coming-soon items accepting interest registration).",

"parameters": {

"type": "object",

"properties": {

"query": { "type": "string", "description": "Free-text search, e.g. 'matte black petg'" },

"material": { "type": "string", "enum": \["PLA", "PETG", "ABS", "ASA", "TPU", "PC", "Nylon", "PLA-CF", "PETG-CF", "PA-CF", "other"\] },

"colour": { "type": "string" },

"diameter\_mm": { "type": "number", "enum": \[1.75, 2.85\] },

"limit": { "type": "integer", "default": 8, "maximum": 20 }

},

"required": \["query"\]

}

},

{

"name": "get\_product\_details",

"description": "Full detail for one SKU: description, specs (print temps, bed temps, density), carton size (units per master carton — relevant to carton-tier pricing), images, subscription eligibility.",

"parameters": {

"type": "object",

"properties": { "sku": { "type": "string" } },

"required": \["sku"\]

}

},

{

"name": "get\_stock\_and\_eta",

"description": "Availability for a SKU across stock pools. Returns: warehouse: {band: in\_stock|low\_stock|out\_of\_stock}, inbound: \[{shipment\_ref, mode, eta\_date, presale\_available (exact int), preorder\_saving\_pence\_per\_unit}\]. If out of stock everywhere, consider offering create\_interest\_flag.",

"parameters": {

"type": "object",

"properties": { "sku": { "type": "string" } },

"required": \["sku"\]

}

},

{

"name": "quote\_price",

"description": "THE ONLY SOURCE OF TRUTH FOR PRICES. Quotes sku+qty+pool. Returns unit\_price\_pence, line\_total\_pence, currency, tier\_applied (single|carton), carton\_multiple\_hint (e.g. 'qty 24 = 1 master carton, unlocks carton tier'), preorder\_discount\_pct (INTERNAL — never quote % to customers), stacked discounts itemised \*\*in pence\*\*, savings\_vs\_base\_pence, quote\_expires\_at. Sell using the £ savings figures only (§15.1a).",

"parameters": {

"type": "object",

"properties": {

"sku": { "type": "string" },

"qty": { "type": "integer", "minimum": 1 },

"pool": { "type": "string", "description": "'warehouse' or an inbound shipment\_ref from get\_stock\_and\_eta", "default": "warehouse" }

},

"required": \["sku", "qty"\]

}

},

{

"name": "view\_basket",

"description": "Current basket: lines \[{line\_id, sku, name, qty, pool, eta\_date?, unit\_price\_pence, line\_total\_pence}\], totals, applied\_codes. Call when unsure of basket state rather than relying on memory.",

"parameters": { "type": "object", "properties": {} }

},

{

"name": "add\_to\_basket",

"description": "Add sku+qty from a pool. Server re-prices authoritatively. Returns the COMPLETE new basket (same shape as view\_basket). On INSUFFICIENT\_STOCK for warehouse pool, check inbound pools before giving up.",

"parameters": {

"type": "object",

"properties": {

"sku": { "type": "string" },

"qty": { "type": "integer", "minimum": 1 },

"pool": { "type": "string", "default": "warehouse" }

},

"required": \["sku", "qty"\]

}

},

{

"name": "update\_basket\_line",

"description": "Change quantity on an existing line (from view\_basket line\_id). qty 0 is invalid — use remove\_basket\_line. Returns complete new basket. Useful for upselling to the carton multiple.",

"parameters": {

"type": "object",

"properties": {

"line\_id": { "type": "string" },

"qty": { "type": "integer", "minimum": 1 }

},

"required": \["line\_id", "qty"\]

}

},

{

"name": "remove\_basket\_line",

"description": "Remove a line. Returns complete new basket.",

"parameters": {

"type": "object",

"properties": { "line\_id": { "type": "string" } },

"required": \["line\_id"\]

}

},

{

"name": "check\_discount\_code",

"description": "Validate a customer-supplied discount code and, if valid, apply to basket. Returns new basket with code applied, or INVALID\_CODE. You cannot create, guess, or improvise codes — only validate ones the customer provides.",

"parameters": {

"type": "object",

"properties": { "code": { "type": "string" } },

"required": \["code"\]

}

},

{

"name": "get\_customer\_interests",

"description": "Logged-in customers only (else LOGIN\_REQUIRED — do not push login on anonymous browsers unless it unlocks something they asked for). Returns active interest\_flags \[{sku|prospective, flag\_type, since}\] and, where a watched SKU is on an inbound shipment, its eta and preorder\_saving\_pence\_per\_unit. Use to open relevantly: e.g. 'the matte black PETG you're watching is on the inbound shipment due 14 Aug — pre-ordering saves £3.00 a roll'.",

"parameters": { "type": "object", "properties": {} }

},

{

"name": "create\_interest\_flag",

"description": "Register a watch on behalf of the customer AFTER they agree. flag\_type: restock (out-of-stock SKU), offers (in-stock SKU), register\_interest (prospective product). Anonymous users: server captures email via a form injected in chat UI — you never handle the address. CONSENT\_REQUIRED errors mean the server needs an explicit consent tick first; explain briefly and move on. Returns the customer's updated flag list.",

"parameters": {

"type": "object",

"properties": {

"sku": { "type": "string" },

"prospective\_id": { "type": "string" },

"flag\_type": { "type": "string", "enum": \["restock", "offers", "register\_interest"\] }

},

"required": \["flag\_type"\]

}

},

{

"name": "escalate\_to\_human",

"description": "Hand off to the owner when the request is outside sales scope: damaged/lost deliveries, refund disputes, trade account requests, anything requiring judgement or promises you cannot verify with tools. Creates a note (with conversation attached) in the owner's queue and tells the customer to expect a follow-up. Never improvise customer-service outcomes instead of using this.",

"parameters": {

"type": "object",

"properties": {

"reason": { "type": "string", "enum": \["delivery\_issue", "refund\_dispute", "trade\_account", "product\_advice\_complex", "other"\] },

"summary": { "type": "string", "description": "1–2 sentence handoff summary for the owner" }

},

"required": \["reason", "summary"\]

}

}

\]

### 14.4 System-prompt behavioural rules (companion to the schema)

Never state a price, discount, ETA, or stock figure that did not come from a tool result in this session.

Express every discount and saving in £ (from savings\_vs\_base\_pence), never as a percentage — "that saves you £6.00", not "that's 15% off" (§15.1a).

Out-of-stock is a sales opportunity, in order: inbound-shipment pre-order → interest flag → alternative SKU.

Upsell honestly at natural moments (qty near carton multiple → mention carton tier with the exact saving from quote\_price; repeat-purchase pattern → mention subscriptions) — never more than once per topic per session.

No invented promotions, price-matching, or delivery promises. Unknown → say so or escalate.

ETAs are estimates; describe them as such ("due around 14 August").

Chat sessions persist to chat\_sessions/chat\_messages (§13.6) including tool calls/results — full replayability.

### 14.5 Later additions (phase 2+)

get\_subscription\_options(sku) and start\_subscription\_signup() (hands to a hosted flow — the agent never takes payment details in chat); get\_order\_status(order\_ref) for post-purchase queries (needs verified login); compare\_products(skus\[\]) convenience read.

## 15\. Discount architecture \[DECIDED in structure — band %s are starting values, validate against real landed costs\]

### 15.1 Governing principle

Every discount names its funding source. Discounts share a real saving or real value the customer created — never arbitrary generosity. This keeps the stack solvent and gives the sales agent honest selling language. The funding source is stated to customers, not just used internally — for pre-orders explicitly: early payment helps our cash flow and part-finances the stock purchase, and that is why the discount is large (see §16.2a for canonical framing).

| Discount | Funding source | Form |
| :-: | :-: | :-: |
| Pre-order | Customer finances stock early; demand certainty; less warehouse dwell | Banded % scaling with time-to-ETA |
| Carton | Handling savings: no de-cartoning, one pick/label/parcel, less packaging | Flat % (\~10%) |
| Subscription | Retention, predictability, float | Credit bonus, NOT a stacking % (see 15.4) |
| Codes | Marketing budget (acquisition/win-back/campaigns) | Best-of vs structural stack, never both |

### 15.1a Presentation rule: discounts are ALWAYS shown in £, never % \[DECIDED\]

Percentages are internal calculation machinery only. Every customer-facing surface — storefront product pages, basket, checkout, emails, and every sales-agent utterance — expresses discounts and savings as monetary values: "Save £4.50 on this roll", "£31.20 off this carton", "pre-order and pay £13.99 instead of £19.99 — £6.00 saved". Rationale: monetary values are more relatable, and they scale visibly with quantity (a carton saving is a big number; the same % is not). Enforcement points: quote\_price already returns savings\_vs\_base\_pence itemised per discount — UI and agent render from that field; the agent system prompt (§14.4) forbids stating percentages to customers; email compose prompts (F6/F7) instruct £-value framing. The band tables below (in %) are config/admin-facing only.

### 15.2 Pre-order bands \[starting values — OPEN to calibration; INTERNAL % — customers see £ per §15.1a\]

| Time to ETA at order | Discount |
| :-: | :-: |
| 60+ days | 20% |
| 30–59 days | 15% |
| 14–29 days | 10% |
| \<14 days | 5% |
| Arrived | 0% — window closes on arrival (the urgency engine: "this price ends when the ship docks") |

Rules:

Band locks at order time. ETA slips → customer keeps price, gets F6 options (wait/swap/refund). Never reprice.

Bands, not curves: communicable, plannable, ungameable-in-pennies.

Discount applies only against presale\_available on the inbound shipment line (§13.4).

### 15.3 Stacking & the floor

Carton (\~10%) + pre-order band stack additively off base price. Max structural stack: 30%.

Price floor, enforced in the pricing engine: min\_price = landed\_cost + variable\_fulfilment + payment\_fees + min\_contribution (e.g. 15%) per SKU. Every quote silently clamps to floor; the floor is never exposed (not to customers, not to the agent's outputs). Misconfiguration can never produce a loss-making order — this is what permits bold band percentages.

Worked example: landed £9, base £19.99 → full 30% stack = £13.99; floor ≈ £12.30 → clears. A £14.99 promo SKU would clamp; nothing breaks.

### 15.4 Subscriptions as credit bonus \[DECIDED\]

Subscription benefit = bonus credit on purchase, e.g. £20/month → £23 credit; £50 → £59 (effective 13–15%, the "best value" tier). Subscribers spend credits at the same shelf/carton/pre-order prices as everyone else.

Why: (a) no three-way discount algebra or floor interactions; (b) unspent credit = float retained in-ecosystem; (c) credits are colour/SKU-agnostic → perfect fit for the skip/swap flexibility model; (d) already supported by subscriptions.credit\_balance\_pence (§13.7). Interest-flag deposits (F8) also convert to credit — same rail.

### 15.5 Codes: best-of rule \[DECIDED\]

Per line: structural stack or code, whichever is better for the customer — never both. check\_discount\_code (§14.3) reports which won. Kills code-on-top-of-stack compounding; simple enough for the agent to explain unhedged.

### 15.6 Deliberate boundaries

Multi-carton / pallet pricing is not public — trade-account territory (negotiated, gated) so print farms sign up rather than scraping the public stack.

If pre-orders ever soften to deposit-based (open Q1): discount tiers with commitment — full payment = full band, deposit = one band lower (cash flow is the funding source; partial cash = partial discount). Not at launch.

### 15.7 Implementation notes

Band table + carton % + floor parameters live in a pricing\_rules config table (per SKU category overridable) — changing commercial policy must never require a deploy.

quote\_price (§14.3) is the single computation path for storefront UI and agent alike; quote\_expires\_at short (e.g. 30 min) since band boundaries move daily with ETA.

Every applied discount itemised on the order line (audit + the agent's "you saved £X" language + Luca GL margin reporting).

## 16\. Payment methods & payment timing \[DECIDED — designed July 2026\]

### 16.1 The rule

| Order type (evaluated per order, at order time) | Payment methods offered |
| :-: | :-: |
| All lines deliverable ≤30 days | Full Mollie method set (cards, wallets, Pay by Bank, PayPal) |
| Any line with ETA \>30 days | Bank payment only: Mollie Pay by Bank (headline option — instant, open-banking) or manual bank transfer. No cards. |

Rationale (stated openly to customers — see 16.2a for the exact framing): (1) your early payment funds our stock purchase — that cash-flow value is the main thing the pre-order discount pays you for, and we say so plainly; (2) card fees on high-value pre-orders are avoided and help fund the deepest discount bands (§15 funding-source discipline — bank payment part-funds the 60-day band); (3) card chargebacks for goods not yet delivered are undefendable — the dispute window runs from expected delivery, so long-dated pre-orders carry long-tail and clustered chargeback risk (a slipped shipment → many simultaneous disputes → threat to the whole card-acquiring relationship). Bank payment removes both.

Payment timing settled (was open Q1): charge at order, all order types. Bank transfer is inherently pay-at-order; the cash-flow thesis (§1) wants it; card orders are short-dated so their chargeback window is small and defensible.

### 16.2 Trust architecture (what replaces card protection)

Removing cards removes Section 75 and chargeback protection on exactly the highest-value orders; "bank transfer only" is also the scam pattern wary buyers screen for. Transparency alone is insufficient — the lost protection is replaced with published commitments:

Cancel any time before dispatch, full refund — extends the statutory 14-days-after-delivery right across the whole waiting period. Costs \~nothing (funds banked; refund = transfer back); directly answers "what if it never comes?".

Lost/abandoned shipment = automatic full refund, stated explicitly.

Refund mechanics stated precisely: back to the paying account, within 5 working days of cancellation.

Plain-English pre-order terms page covering: the honest cash-flow exchange (§16.2a) — early payment funds stock, hence the discount; ETA is an estimate; band locks at order; F6 options if the ETA slips (wait / swap at pre-order price / refund); the payment-method rule and its reasons; cancellation rights.

F6 proactive notifications are themselves trust infrastructure — customers who hear about delays from us first don't panic.

### 16.2a Honest cash-flow framing \[DECIDED\]

The customer-facing explanation links early payment and discount explicitly and honestly. We do not dress the discount up as generosity or the payment rule as mere policy: paying early helps our cash flow — it part-finances the stock purchase — and that is why the discount is big and grows with how early the commitment is made. Canonical framing for the pre-order terms page, product pages, checkout, and the sales agent (adapt wording, keep the logic):

"When you pre-order, you pay up front for stock that hasn't arrived yet. That helps our cash flow — your money helps fund the shipment — and that's exactly why we give you a big saving in return: the earlier you commit, the more it's worth to us, and the more we take off your price. Paying by bank transfer also means we pay no card fees, and that saving goes into your discount too. In return for paying early you're protected: cancel any time before dispatch for a full refund, and if the shipment is lost you get every penny back automatically."

Why honesty is also the persuasive choice: an unexplained discount invites suspicion ("what's wrong with it?"); a discount with a named funding source reads as a fair trade. The framing deliberately raises the customer's natural next question — "what protects my early payment?" — and answers it in the same breath with the §16.2 commitments. Never let marketing copy drift into presenting the discount as a sale, promotion, or generosity: it is a priced exchange, and saying so is the brand.

Default delivery obligation is 30 days unless a longer period is expressly agreed — so \>30-day orders legally require explicit agreement to the timeline anyway. Checkout for these orders carries one unticked, specific confirmation capturing: estimated arrival date + "estimate" status, the payment rule, and the cancel-before-dispatch right. One tick = legal requirement + transparency goal. 14-day post-delivery cancellation right unaffected and stated.

### 16.4 Mechanics

Mixed baskets: never force bank-only onto in-stock lines — checkout offers a split ("in-stock items ship now, card OK; pre-order becomes a separate bank-payment order").

Manual-transfer payment window: presale allocation + discount band reserved at order for 5 days; reminder composed day 3 (standard compose pipeline); unpaid day 5 → order lapses, allocation releases, polite notice. Unique payment reference per order.

Pay by Bank avoids the window entirely (confirms in minutes over Faster Payments) — hence headline placement. Note: Mollie Pay by Bank was in beta at time of writing — request activation via Mollie support early. Some issuing banks settle as standard (not instant) transfer — treat pending → paid transition as the trigger, not checkout completion.

Reconciliation synergy: manual transfers matched via Luca GL bank-statement import/matching (existing tooling); store emits order.payment\_received on match.

New events/jobs (extends §12): order.awaiting\_payment status; events order.payment\_received, order.payment\_overdue, order.lapsed\_unpaid; scheduled job payment-window-scan (daily) emitting the overdue/lapse events.

Sales agent (extends §14.4): the agent explains the payment rule when quoting \>30-day pre-orders using the §16.2a framing — early payment helps our cash flow and funds the shipment, which is why the saving is big; fee saving adds to it; cancel-anytime protects the customer — and never presents card payment as available on those orders.

### 16.5 Fee note

Bank payment saves \~1.5–2.5% vs cards; on a £300 carton pre-order that is £5–7 per order — genuine part-funding of the 20% band (§15.2).

## 17\. Approval queue UX \[DECIDED — designed July 2026\]

### 17.1 Design goal

Five seconds per draft, from a phone, while packing boxes. The queue is (a) the owner's highest-frequency admin surface and (b) the trust instrument that graduates agents to autonomy. Mobile-first screen in the existing admin SPA.

### 17.2 Core mechanic: review the facts, not the prose

Every draft renders beneath a facts panel built from its trigger\_event\_id (§13.5): customer, order lines, old→new ETA, amounts paid, options offered with prices. The reviewer's task is "do the facts match the prose?" — a glance, not an investigation. This is the payoff of storing the trigger event pointer on every draft.

### 17.3 One inbox, priority-ordered

Single list containing message drafts and sales-agent escalations (escalate\_to\_human, conversation attached). Order = urgency, not recency:

ETA-change notices to paid customers (time- and trust-critical; show expiry countdown)

Escalations

Back-in-stock fanouts

Nightly marketing (has a send window; waits for morning coffee)

### 17.4 Batch review for homogeneous groups

Drafts sharing trigger type + template are grouped (e.g. a 38-recipient back-in-stock fanout). Reviewer sees one rendered instance + 2–3 random spot-checks, then "approve group". Randomised spot-checks police personalisation variance without reading every email; per-draft review of homogeneous batches degenerates into rubber-stamping and is explicitly avoided.

### 17.5 Actions

Approve — one tap/swipe; the 90% case.

Edit — inline subject/body, then approve. Edits diff-logged on the draft.

Reject — mandatory one-tap reason code: wrong\_facts | wrong\_tone | should\_not\_send | other.

Edits + rejection reasons are the prompt-improvement dataset (joins llm\_log, §13.6): every correction made while packing boxes is a labelled example for tuning compose prompts.

### 17.6 Graduation to auto-send (per event type, measured)

Queue tracks approved-without-edit rate per event type and surfaces it when high: "back-in-stock: last 50 drafts, 96% approved unedited — enable auto-send?" Owner flips a reversible per-type toggle. Auto-sent messages (status auto\_approved) still appear in the daily digest — nothing becomes invisible. This operationalises F6's "once trust is established" as a measured control.

### 17.7 Staleness protection

Time-sensitive drafts carry expires\_at (schema delta to message\_drafts, §13.5). Expired → status failed with reason expired; digest surfaces them. Prevents late-sending zombie apologies after time away.

### 17.8 Schema deltas

message\_drafts: add expires\_at timestamptz, group\_key text (trigger type + template hash for batching), reject\_reason text, body\_original text (pre-edit copy for the diff).

New per-event-type config: auto\_send\_enabled boolean + rolling approval stats (computable from drafts; cache optional).

Escalations: escalations table (id, chat\_session\_id, reason, summary, status open/resolved, created\_at) — same inbox, different item type.

### 17.9 Digest integration

Daily agent digest (§6) links deep into the queue: counts by type, auto-sent summary, dead-letters, expired drafts, open escalations.