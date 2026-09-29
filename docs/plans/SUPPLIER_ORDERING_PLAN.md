# Supplier ordering — plan

*Drafted 29 Sept 2026. Status: proposal, nothing built. Decisions marked
**DECIDE** need an owner's answer before the phase that depends on them.*

The goal is to raise purchase orders to suppliers from Auto-Stock, and to book
in what actually arrives against them. We start with a process a person drives
by hand. Once that runs reliably, the same pipeline is automated one step at a
time. Throughout, every order, confirmation, delivery and invoice feeds back
into the data the next order is based on.

---

## 1. Where we are starting from

### 1.1 What already exists

- **Buying options:** `supplier_products` maps (product, supplier, supplier code)
  and holds the pack size, `cost_gbp` and a `priority`. `supplier_product_aliases`
  holds the other spellings of a code, and `resolveSupplierSku()` resolves any
  spelling to its row. About 460 mappings were mined from a year of OCR'd
  invoices (`DECISIONS.md` §F20) and then audited against them
  (`audit-supplier-mappings.ts`, Sept 2026).
- **Demand:** the reorder engine (`modules/reorder/`) raises a
  `reorder_proposals` row per (product, site) when `on_hand` falls to the
  reorder point. It sizes the order up to par, or by the demand estimator on
  28-day usage, and rounds up to the pack. The admin *Reorder suggestions* page
  lists these proposals and lets you approve or place them.
- **Supplier connector framework:** there is a `SupplierConnector` interface,
  a registry, a poll worker and an order-placer worker with retry and
  idempotency. It was built for **drop-shipping** (Uneek, Ralawise).
- **Goods-in:** the iPad screen books receipts into the per-site stock ledger.
  It has batches, a venue confirmation step, undo by reversing receipt, and a
  GRN posting to Xero (still dry-run).
- **Invoice history:** BumbleBee's invoice OCR holds every purchase line
  (supplier, code, pack text, quantity, price, venue, date).

### 1.2 What is missing, and matters for this plan

| Gap | Consequence |
|---|---|
| A proposal is one product at one site. There is **no multi-line purchase order** linking proposals, the supplier's order and the delivery. | Nothing groups "what we're sending to Brakes for London East on Thursday". Goods-in can't be booked against an order. |
| `place()` never calls a connector and never sends an email. `renderEmailPO` stores a PO that goes nowhere. | Today the only way to place an order is outside the system. |
| The connector interface is drop-ship shaped: a customer reference and shipping address, with no site account, PO number, price, delivery date or per-line confirmation. | It can't carry a stock order or a supplier's reply. |
| Suppliers have no **delivery days, cut-off, minimum order or delivery charge** columns. `lead_time_days` exists but nothing reads it. | We can't tell which option actually arrives soonest, or what a small order really costs. |
| Supplier choice is `priority`, then `cost_gbp`. It ignores pack size, delivery date and availability, and doesn't compare price **per stock unit**. | A 6×1.5 kg pack and a 25 kg sack are compared on pack price. That comparison is meaningless. |
| The poll worker refreshes stock only (both connectors return `costGbp: null`). Goods-in never updates any price. Only the legacy PO book-in writes `expected_next_cost`. | Prices go stale the day they're imported. |
| Goods-in captures no supplier, delivery-note number or photo, and has no link to an order. A scanned **supplier** code isn't resolved (lookup is product barcode, then EAN, then stock code). There are no pack or case barcodes. | Nothing to reconcile against, and no way to record a substitute or short delivery. |
| Goods-in writes are not in one database transaction, and reversing a receipt doesn't reverse its batches. | This needs fixing before orders depend on receipts. |

There is also an older, inherited set of tables: `purchase_orders`,
`purchase_order_lines` and `goods_received_notes`, with admin pages. It has a
delivery-note field, but it books into the old warehouse `stock_items` model,
not the per-site ledger. That makes it a starting point, not something to
use as it stands (§3.1).

### 1.3 What the suppliers can actually do

This is from web research. Supplier sites blocked full page reads, so this
rests on search snippets of their pages. **Confirm each point with the account
managers.**

| Supplier | Stock spend, last 12 months | Electronic ordering, as far as we can tell | Cut-off |
|---|---|---|---|
| Brakes | £95.3k (370 invoices) | Web and app (mybrakes) with account prices and substitution emails. **Customer-side electronic ordering exists** (owner-confirmed, 29 Sept): Brakes is an EDI trading partner, and has ordering integrations with Apicbase and Crunchtime that place orders straight into Brakes' system. It also has a product-data API (allergens). **No self-serve public API** — access is by onboarding (§9.1). | Per account; amend up to cut-off |
| Amazon (Business) | £38.5k (**1,261 invoices**) | **A real public Ordering API** (JSON, OAuth), plus Product Search and Reconciliation APIs, UK supported. Needs Amazon's approval. | n/a |
| Twist Ingredients | £28.8k | Not researched yet | ? |
| LWC Drinks | £28.1k | Ordering portal with live pricing. No API found. | Per depot, around 4pm for next day |
| Culpitt | £25.3k | Trade web shop (Red Technology's "tradeit" platform). No API found. | Midday for next working day |
| Booker (+ Makro) | £15.7k + £6.9k | **Customer EDI exists.** Kobas uses it with per-venue Booker location IDs from your Booker contact. Makro is part of Booker Group. | 9am for next day |
| JM Posner | £10.9k | Web shop only | ? |

Alibaba, Supreme Creations and Young & Co are large one-off or merchandise
buys. They are out of scope for replenishment.

**What follows from this:**

- Most of the money goes to suppliers **without** a public API.
- The plan can't assume one ordering mechanism per supplier. Each supplier
  gets a **channel**: email, portal, API or EDI.
- The manual phase is not a stepping stone to throw away. For several
  suppliers it will stay the process for a long time, and it has to be good.
- The purchase order, the ranking and the delivery reconciliation are the same
  whatever the channel. Automation means swapping how an order is sent and
  how the reply comes back.

---

## 2. The process we're building

Every order goes through the same seven steps. Each step names who does it in
the manual phase and what later automates it.

```
 1 NEED  ─►  2 BASKET  ─►  3 RAISE PO  ─►  4 SEND  ─►  5 CONFIRM  ─►  6 RECEIVE  ─►  7 MATCH
 (engine)    (ranked by     (per supplier  (channel)   (supplier's    (iPad, against  (invoice vs
             price-that-     + site +                  reply: subs,   the PO: subs,   PO + receipt;
             arrives-in-     delivery date)            shorts, date)  shorts, extras) price feedback)
             time)
```

| Step | Manual phase (people) | Automated later |
|---|---|---|
| 1 Need | The reorder engine proposes, as today. Head office can also add any item by hand. | Same, on a schedule timed to each supplier's cut-off |
| 2 Basket | Head office reviews the ranked options, can override, and sees minimum-order and cut-off warnings | The rules pick; a person only sees exceptions |
| 3 Raise PO | One button per supplier, site and delivery date | Automatic, within guardrails (§7) |
| 4 Send | Email: the system sends it. Portal: the system gives a keyed-up list and you paste back the supplier's order number. | API or EDI |
| 5 Confirm | Record the confirmation, from the email or the Brakes 6am substitution email | The supplier's order response (API or EDI) |
| 6 Receive | The venue books in on the iPad against the expected delivery | Pre-filled from the supplier's delivery note (ASN) where one exists |
| 7 Match | Head office matches the invoice (already OCR'd by BumbleBee) to the PO and receipt | Automatic matching; only exceptions queued |

---

## 3. Data model

These tables sit on top of what exists. Migrations continue from `0054`.

### 3.1 The purchase order

**DECIDE (A): extend the inherited `purchase_orders` / `purchase_order_lines`,
or start fresh tables.**

- **Recommendation: extend.** They already have a PO number, totals, delivery
  status, `qty_booked_in` and admin pages.
- **The change needed:** swap `delivery_warehouse_id` for `site_id`, and
  retire the legacy book-in path so goods-in is the only way stock comes in.
- **The risk:** the legacy tables carry drop-ship-era assumptions, and some
  of their admin UI would need rework.

Whichever we choose, the purchase order needs these fields.

**PO header:**
- `site_id`, `supplier_id`, `supplier_account_id` (§3.2)
- `po_number`, in the format `BB-<SITE>-<seq>`
- `channel` (EMAIL / PORTAL / API / EDI)
- `status`, see the lifecycle below
- `requested_delivery_date`, `confirmed_delivery_date`
- `supplier_order_ref`, `idempotency_key`
- `sent_at`, `sent_by`, `confirmed_at`
- `raised_by`: a person, or `auto`

**PO line:**
- `product_id`, `supplier_product_id`: the code and pack we ordered
- `qty_ordered` in purchase units, and `unit_price_quoted` with its source (§4.3)
- `qty_confirmed`, `unit_price_confirmed`, `line_status`
- `substitute_for_line_id`, for a line the supplier added as a substitute
- `qty_received`, `qty_invoiced`
- `reorder_proposal_id`, so a proposal is marked done when its line is raised

**Lifecycle:**

```
DRAFT → SENT → CONFIRMED | PART_CONFIRMED | REJECTED
      → PART_RECEIVED → RECEIVED → INVOICED → CLOSED
(CANCELLED is reachable up to cut-off)
```

**Proposals:** stay as the per-(product, site) demand signal they are now.
Raising a PO marks each proposal `ORDERED` with a link to its PO line.

### 3.2 Supplier account per site: `supplier_site_accounts`

Brakes, Booker and LWC each know each venue by its **own account number**.
Booker's EDI needs a location ID per venue. Delivery days and cut-offs also
differ by depot, so they belong on the account, not on the supplier. One row
per (supplier, site):

- `account_number`, and `edi_location_id` (for Booker)
- `delivery_days` (e.g. Tue, Thu, Sat)
- `cutoff_time` and `cutoff_days_before`
- `lead_days`, for suppliers without a delivery calendar (Amazon, web shops)
- `min_order_value`, `delivery_charge`, `free_delivery_over`
- `channel`, `order_email`, `portal_url`
- `is_active`

This is what turns "cheapest" into "cheapest that arrives in time" (§4).

### 3.3 Price observations: `supplier_price_observations`

This is an append-only history of every price we see for a buying option:

- `supplier_product_id`, `site_id` (nullable; prices can differ by depot or account)
- `unit_price` per purchase unit, `pack_size_seen`
- `source`: QUOTE_API | CATALOGUE_FILE | PO_CONFIRMED | INVOICE | GOODS_IN | MANUAL
- `observed_at`, `document_ref`

`supplier_products.cost_gbp` becomes a **derived** value: the latest
observation from the most trusted source. `products.expected_next_cost` is
derived from the option the ranking would choose today.

Keeping the history, not just the latest number, gives three things:
- **Staleness is visible:** every price shows where it came from and how old it is.
- **Variance is visible:** "Brakes flour was £18.40 three months ago, now £21.10".
- **A bad OCR read can be outvoted, not just overwritten.**

### 3.4 Pack and case barcodes

- **Add `supplier_products.barcode`** (the GTIN on the case).
  - A case of 12 × 1 L has a different barcode from the 1 L bottle.
  - Today scanning the case finds nothing, or finds the unit.
  - Scanning a case barcode at goods-in should resolve to that pack and
    convert to stock units from it.
- **Where the codes come from:** they are learnt at goods-in. The existing
  "attach this code" flow is extended to attach a code to a supplier pack.

### 3.5 Delivery and discrepancies

These extend `goods_in_receipts` and its lines.

**Receipt:**
- `purchase_order_id`
- `delivery_note_number`, required when booking against a PO
- the delivery-note photo, see §6.4

**Line:**
- `purchase_order_line_id`
- `supplier_code_received`, `pack_received`
- `line_outcome`: AS_ORDERED | SHORT | OVER | NOT_DELIVERED | SUBSTITUTE | UNEXPECTED | DAMAGED | REFUSED

**New table `delivery_discrepancies`:** one row per short, damaged, refused or
wrong item, with:
- its value
- the credit note expected from the supplier
- a status: OPEN → CLAIMED → CREDITED | WRITTEN_OFF

This becomes the claims queue.

---

## 4. Best price that can arrive in time

### 4.1 Compare like with like

Every buying option is converted to **cost per stock unit**:

```
cost per stock unit = unit price ÷ (supplier pack size × product purchase-to-stock factor)
```

On this basis:
- 25 kg of flour at £21 is **84p/kg**.
- 6 × 1.5 kg at £9.90 is **£1.10/kg**.

The comparison needs a numeric `supplier_pack_size`. The invoice import
deliberately never guessed it (Brakes' `100x1` versus `1x100`). So
**option ranking is only as good as the pack sizes head office has filled
in**. A mapping without one is shown as "can't compare", never silently
ranked.

### 4.2 The ranking rule

For each item that needs ordering at a site:

1. **Need-by date.** Take today plus days of cover remaining (`on_hand ÷` the
   estimator's daily usage), minus a safety margin (**DECIDE (B)**: suggest 1
   day, per site).
2. **Next arrival for each option.** Use the site account's delivery days,
   cut-off and lead days to find the earliest delivery date if ordered now.
   Drop options the supplier says are unavailable (API stock or a recent
   substitution) and inactive accounts.
3. **Pick:**
   - Among options that **arrive by the need-by date**, choose the lowest cost
     per stock unit.
   - If **none** arrive in time, choose the **earliest arrival**. Flag the line
     "can't arrive before you run out (Thu)", so a person can decide whether
     to make a local purchase.
4. **Adjust for the basket.** Weigh a slightly dearer option against the
   supplier's delivery charge and minimum order:
   - An item might be 3p/kg cheaper at Culpitt, but Culpitt isn't otherwise
     on this site's order, and an order under £95 carries a delivery charge.
     In that case it should ride along on the Brakes order that is going anyway.
   - To do this, score each supplier's basket for the site, not each line
     alone. Suggest the basket "moves" that save money overall.
5. **Tie-break** on `priority` (head office's preference) and reliability
   (§5.3).

In the manual phase, the basket shows the **chosen option and the runners-up**,
each with cost per unit, arrival date, price source and price age.

- Head office can switch any line.
- Overrides are recorded with a reason picked from a short list: quality,
  brand, relationship, price wrong, other.
- The override log shows where the rule is wrong before we let it run
  unattended.

### 4.3 Price freshness

**A price used for ranking shows its age and source.**

- **Older than 60 days** (**DECIDE (C)**): the price is marked "stale". The
  basket still ranks it, and suggests a check.
- **API suppliers** (Amazon, and later any with a price API): the basket asks
  for a **live quote** when it is built, so that price is minutes old.
- **Brakes, Booker and LWC** show personalised prices in their portals. There,
  the price refreshes when the order confirmation and invoice come back
  (§5.1). So a supplier we order from often stays fresh on its own. One we
  rarely use goes stale, and that is flagged.

---

## 5. Keeping the data fresh: every step writes back

Refresh doesn't come from one nightly job. It comes from every step of the
process writing back what it learnt. A scheduled check then reports what has
gone stale.

### 5.1 What each event updates

| Event | What it teaches us | Written to |
|---|---|---|
| API quote or catalogue file | Current price, pack, availability | price observation (QUOTE/CATALOGUE); `last_known_stock` |
| Order confirmation | Confirmed price and quantity, substitutions, delivery date | price observation (PO_CONFIRMED); substitution noted against the option (§6.3) |
| Goods-in | What arrived: pack, quantity, cost if entered, code on the case | price observation (GOODS_IN); new alias or pack barcode (confirmed by a person); `qty_received` |
| Invoice (BumbleBee OCR) | **What we actually paid.** The most trusted price. New spellings of codes. | price observation (INVOICE); alias candidates; `qty_invoiced`; price variance against the PO |
| Delivery date against promised date | Supplier and depot punctuality | reliability stats (§5.3) |
| Fill against order | Supplier fill rate | reliability stats |
| Usage (sales, bakes, wastage) | Daily usage per item and site | demand estimator: reorder point and par (exists; should read `lead_days` from the site account instead of the fixed 3) |

**The invoice feed:** it already exists in BumbleBee, but today we pull it with
one-off captures capped at 500 rows. This plan needs a **proper incremental
feed**, meaning invoice lines since a timestamp, paged. That is a BumbleBee
change. Until it exists, a weekly capture script (the §F20 tooling) is the
fallback.

### 5.2 A "data health" page

This is a scheduled check, surfaced on one admin page and in a weekly email.
It lists:

- Products with a reorder point but **no active buying option**, or whose
  options all lack a pack size or price.
- Buying options whose price is **stale** (older than the §4.3 threshold), and
  those not bought in 6 months (candidates to deactivate).
- Codes seen on invoices with **no mapping**, busiest first. The §F20 work
  list, kept live.
- Supplier site accounts missing delivery days or a cut-off.
- Price moves over ±10% (**DECIDE (D)**) since the last order.
- Open discrepancies older than 14 days.

### 5.3 Reliability

For each supplier and site, keep two figures over the last 90 days:
- **on-time rate:** delivered on the confirmed date
- **fill rate:** lines delivered as ordered

A supplier that fills 70% of lines is worse than its price suggests. The
ranking takes this into account (§4.2 step 5), and the basket shows it.

---

## 6. Delivery notes and booking in

### 6.1 The venue's view

The goods-in screen opens with **"Expected today"** for the venue: the
confirmed POs due today, plus yesterday's that didn't arrive. The person
booking in has three routes:

- **Picks the delivery** (e.g. "Brakes, PO BB-LE-000231, 14 lines"). The lines
  come up **pre-filled with the confirmed quantities**, and the person corrects
  them rather than keying everything in.
- **Enters the delivery-note number and photographs the note.** Both are
  required against a PO. The photo is evidence for any claim.
- **"Delivery with no order"** remains for walk-in purchases and emergency
  buys, capturing the supplier and note number.

On each line they confirm, change the quantity, or mark the line **not
delivered / damaged / refused**. A line can also be marked **"different
item"** (§6.2), and any extra item can be added by scanning it.

### 6.2 Substitutions and alternative sizes

These cases are handled differently because they affect stock differently.

| What arrived | How it's booked | Stock effect |
|---|---|---|
| **Same product, different pack.** Ordered a 25 kg sack, received 4 × 6 kg. | Scan the case or type the code. `resolveSupplierSku` (plus the new case barcode) finds the right pack option. If none exists, the person enters the pack, and head office confirms it as a new option. | Converted to stock units **from the pack actually received**: 24 kg, not 4 sacks = 100 kg. Cost per unit comes from that pack. |
| **Equivalent product** (different brand, same use). Ordered brand A caster sugar, received brand B. | Booked as **the product that arrived**, linked to the PO line as its substitute | See the decision below |
| **A different product** (not interchangeable) | Booked as that product, marked **UNEXPECTED**. Head office decides whether to keep it (the supplier invoices it) or return it (a discrepancy row). | Stock reflects it; a claim is opened if returned |
| **Short / not delivered** | Line outcome SHORT or NOT_DELIVERED | The PO line stays **open as a back-order** or is **closed short** (see below) |
| **Over-delivered** | Line outcome OVER | Book what arrived. A discrepancy is raised only if we're refusing the extra. |

**Closing a short:**
- If the item is still needed and the supplier won't back-order, the ranking
  re-runs **excluding that supplier for that item this week**. The next-best
  option is offered, which is often a same-day local purchase.
- In the manual phase this is a prompt to head office. Later it is automatic,
  within guardrails.

**DECIDE (E): equivalent products.**
- **The problem:** recipes consume a specific product. If brand B caster sugar
  arrives and is booked as brand B, the next bake still draws down brand A.
  Brand A goes negative and brand B never moves.
- **The options:**
  1. Book the substitute **as the ordered product**, with a note. Simple, but
     the ledger then records something that didn't happen.
  2. Introduce **interchangeable groups**. A small table marks products that
     are the same thing for stock and recipe purposes. Consumption and counts
     then draw from the group.
  3. Keep them separate and live with the drift until the next stock-take.
- **Recommendation: option 2, only for groups head office creates.** The
  first time a substitute is received, the screen offers "treat as the same
  as <ordered item>?"; head office confirms it once, and it applies from then
  on.

### 6.3 What the supplier tells us before the van arrives

**Manual phase:**
- Head office records the supplier's confirmation on the PO: confirmed
  quantities, substitutes and delivery date.
- For Brakes, the **6am substitution email** is the source.
- This matters because the venue's expected list is then already right on the
  morning of delivery.

**Later:**
- The order response (API or EDI) and, where offered, an **advance shipping
  notice** (the electronic delivery note) fill this in automatically.
- The substitution convention seen in Bidfood's integrations is the likely
  shape, so the data model should expect it:
  - the original line is marked "unavailable";
  - a new line is added carrying `substitute_for_line_id`.

**Cheaper intermediate step (a guess — to test):**
- Forward the confirmation emails into a mailbox Auto-Stock reads.
- Extract the lines with the same OCR/LLM approach BumbleBee uses for
  invoices.
- This isn't built anywhere yet.

### 6.4 Photos and documents

- **Today:** `image_captures` stores only an image URL. There is no upload
  endpoint and no file storage.
- **What this plan needs:** a small upload endpoint with object storage (an
  S3-compatible bucket, or Coolify-hosted MinIO). Photos are then stored
  against the receipt.
- **Why:** delivery-note photos are the evidence for credit claims and the
  input to any future OCR.

### 6.5 Hardening before any of this

- Put `GoodsInService.receive` in **one database transaction**. At the moment
  a failure part-way can leave movements without a receipt.
- Make **reversal reverse batches** too.
- **Retire the legacy PO book-in path** (§3.1), so `expected_next_cost` isn't
  written from two places.

### 6.6 Accounting

- **At goods-in:** the GRN already posts *Dr Stock / Cr GRNI accrual* to Xero
  (dry-run). PO-based receipts keep that.
- **When matching:** step 7 records the price variance between the receipt
  and the invoice.
- **Not in this plan:** clearing GRNI against the supplier bill in Xero. Today
  supplier invoices post to Luca, not Xero.
  - **Flag for the CFO:** this is the three-way match (PO, receipt, invoice),
    which accounting will eventually want.
  - This plan produces the data for it, but not the posting.

---

## 7. From manual to automatic

Automation is switched on **per supplier and site, one step at a time**. Every
step has a dry-run mode, like `XERO_DRY_RUN`, and a kill switch.

| Level | What runs without a person | Guardrails |
|---|---|---|
| 0 Manual | Nothing is sent; the system prepares everything | — |
| 1 Assisted | The basket builds itself before each supplier's cut-off and emails head office "ready to send" | — |
| 2 Send unless stopped | The PO sends itself at *cut-off minus N minutes* unless someone holds it | Value cap per PO; price within ±X% of the last invoice; no "can't compare" lines; no stale prices; no open discrepancies with this supplier |
| 3 Full auto | Orders are placed; confirmations, receipts and matches are processed; only exceptions reach a person | As level 2, plus a daily digest of everything that was done |

**Timing:**
- The sweeps are not yet running on a schedule (see `DEPLOY_COOLIFY.md`).
- Level 1 and above need a **per-supplier schedule derived from the cut-offs**.
- Booker's 9am cut-off means its basket must be ready by about 8am.

**Connector interface:**
- Add a **stock-ordering interface** alongside the drop-ship one, rather than
  bending `SupplierConnector`.
- It reuses the registry, the encrypted credentials, and the poll and placer
  worker pattern (spec §A2).
- Its methods are:
  - `quote(lines)` — price and availability
  - `deliveryOptions(account)`
  - `placeOrder(po)` — returns accepted or rejected, plus per-line confirmations
  - `orderResponse(ref)` — substitutions, shorts and the delivery date
  - `deliveryNote(ref)` (ASN) and `invoices(since)`
- **Every method is optional**, and each connector declares what it supports.
- **Email and portal become connectors too.** Email *sends*. Portal prints a
  keyed-up list and waits for a person to paste back the order number. The
  pipeline is therefore the same for every supplier, and automating a
  supplier means swapping its connector.

---

## 8. Phases

Each phase ends with something the venues or head office use.

**Phase 0 — groundwork (about 1 week of build)**
- Goods-in hardening (§6.5).
- `supplier_site_accounts`, filled in for the top suppliers.
- `supplier_price_observations`, back-filled from the invoice capture.
- Pack sizes filled in for the top ~150 lines by spend. This is data work for
  head office, with a work list.
- The data health page (§5.2).
- **At the same time:** the supplier conversations (§9).

**Phase 1 — manual ordering, end to end (about 3–4 weeks)**
- Purchase orders (§3.1), the basket with the ranking and runners-up (§4), and
  raise and send.
  - The email channel actually sends. This needs SMTP/SendGrid, which has not
    been set up yet.
  - The portal channel prints the list and records the reference.
- Recording confirmations.
- Goods-in against the expected delivery, with delivery-note number and photo,
  line outcomes, substitutions and pack conversion (§6).
- The discrepancy queue.
- Invoice matching against the weekly capture.
- **Exit criteria:** all Brakes, Culpitt, LWC and Booker orders for two venues
  go through the system for three weeks. Every delivery is booked against its
  PO. Overrides and discrepancies are reviewed.

**Phase 2 — the first connectors (about 2–3 weeks each, once access is granted)**
- **Brakes EDI — the priority.** Brakes is about a quarter of stock spend, and
  customer-side EDI is confirmed (§9.1). Its order response and substitution
  messages also do the most for goods-in, because Brakes deliveries have the
  most lines. Build time depends on Brakes' onboarding and test cycle, not
  our code; start the conversation now.
- **Amazon Business Ordering API**, in parallel. It is the only self-serve
  public API. With 1,261 invoices a year it is the highest *order count*, so
  it saves the most keying.
- **Booker EDI**, if Booker grants it. Customer EDI with per-venue location IDs
  is proven elsewhere (Kobas).
- **Confirmation-email reading** (§6.3), as the fallback for suppliers without
  either.

**Phase 3 — automation (rolling)**
- Levels 1 → 3 per supplier (§7).
- Scheduled sweeps timed to the cut-offs.
- Automatic re-sourcing of shorts.
- Reliability in the ranking.

The estimates are a guess at build effort, not a commitment. The supplier
conversations will move Phase 2 more than any build work.

---

## 9. Questions to put to suppliers now

For each of Booker (+Makro), LWC, Culpitt, Twist Ingredients and JM
Posner (and Brakes, alongside §9.1), ask the account manager:

1. Can a customer place orders electronically from its own stock system: API,
   EDI (which standard?), a procurement platform, or order-file upload?
2. Is there an **order response** (confirmed lines, substitutions, delivery
   date) and an **advance delivery note**? In what format?
3. Can we get our **account-specific price list** as a file or feed, and how
   often?
4. Per venue: account number, delivery days, cut-off, minimum order, delivery
   charge.
5. How are substitutions communicated, and can we opt out of them per item?
6. Is there a case/outer barcode (GTIN) on the price list?

### 9.1 Brakes — specific questions

Brakes supports EDI and integrates with ordering platforms, so the questions
are about onboarding, not whether it's possible:

1. Will Brakes onboard **our own system** as an EDI customer, or only through a
   listed platform (Apicbase, Crunchtime, a procurement platform)?
2. **Which standard and transport?** EANCOM/EDIFACT, Tradacoms, cXML or
   Brakes' own XML/JSON; direct AS2/SFTP, or through a VAN such as TrueCommerce.
   Is there a specification document and a **test environment**?
3. Which messages: order, **order response** (confirmed lines, substitutions,
   delivery date), **advance delivery note**, invoice and credit note, and a
   price/catalogue file?
4. How is each venue identified: account number or GLN? Are cut-off and
   delivery days per account?
5. Can the **allergens/product-data API** be used for our catalogue? This
   would keep ingredient allergens in step with what Brakes actually ships,
   including substitutes. It is not needed for ordering, but it is useful.

⚠️ Much of the "Brakes EDI" material online is written for **manufacturers
selling to Brakes**, not customers buying from it. Make sure the answer is
about the customer side.

### 9.2 Amazon Business

Request developer access for the Ordering, Product Search
and Reconciliation APIs (the approval form is on the Amazon Business developer
docs).

**DECIDE (F): build per-supplier connectors, or join a procurement
platform?**
- Access Procure Wizard, Fourth Trade Simple and Apicbase already hold
  connections to most UK foodservice suppliers.
- **Joining one would mean:** one integration instead of six, but a
  subscription cost. The platform would also become part of the ordering
  path.
- **What we now know:** Brakes' ordering integrations are with platforms
  (Apicbase, Crunchtime). So the platform route definitely works for Brakes.
  The direct route depends on Brakes agreeing to onboard us (§9.1 q1).
- **Recommendation:** ask the suppliers first. If Brakes and Booker both
  answer "only through a platform", price the platform against the build.

---

## 10. Decisions needed

| | Decision | Recommendation |
|---|---|---|
| A | Extend the inherited PO tables, or start fresh | Extend; retire legacy book-in |
| B | Safety margin before the run-out date | 1 day, adjustable per site |
| C | When a price counts as stale | 60 days |
| D | Price-move alert threshold | ±10% |
| E | How equivalent substitutes affect stock and recipes | Interchangeable groups, created by head office |
| F | Per-supplier connectors or a procurement platform | Ask suppliers first, then price the platform |
| G | Who can raise and send POs in the manual phase | Head office only at first; site managers later for top-ups |
| H | Should shorts re-source automatically, or always ask | Always ask in Phase 1 |
