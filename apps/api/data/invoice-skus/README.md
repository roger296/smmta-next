# Supplier codes from the invoices

Which supplier code buys which product, mined out of a year of OCR'd purchase
invoices.

Source: the BumbleBee MCP tool `bumblebee_invoice_purchase_prices`, captured on
2026-09-16 into **`bumblebee-purchase-lines.json`** and committed here so the
extract is reproducible without a BumbleBee API key — the same arrangement as
`../invoice-suppliers/`.

## Why this exists

`../invoice-suppliers/` proved *who* Big Bakes buys from. It carries nothing but
the name. This is the layer below: the code, the pack and the price on the line.
Auto-Stock cannot raise a purchase order for a product it has no supplier code
for, and entering them by hand is a couple of thousand codes across nine
suppliers.

## The pipeline

```
bumblebee-purchase-lines.json          8,812 OCR'd invoice lines
  │   npx tsx apps/api/scripts/extract-invoice-skus.ts
  ├─► supplier-skus.csv                461 mappings, ready to import
  ├─► supplier-skus-review.csv         548 held back, each with its reason
  └─► extract-report.txt               the counts, so a re-run can be diffed
        │   npx tsx apps/api/scripts/import-invoice-skus.ts --dry-run
        └─► supplier_products + supplier_product_aliases
```

## ⚠️ How the capture was windowed, and why it matters

There is no REST route for this data. `purchase_prices` exists only as an MCP
tool, and it ends in `rows[:500]` — **no `total_count`, no offset**. A window
holding 501 matching lines returns 500 of them and says nothing at all.

So the capture is windowed by supplier and date to stay under that cap, and
every window was counted afterwards. **Seven came back with exactly 500 rows and
were discarded**, not used, and re-fetched narrower. `capture.cap_checked` in
the JSON records that this was done, and `extract-invoice-skus.ts` refuses to
run on a file without it. A supplier catalogue that is quietly missing codes is
the worst outcome here: the missing ones look exactly like items nobody buys.

Brakes is 6,301 of the 8,812 lines and is sampled one window per month across
the year, plus contiguous recent weeks for fresh prices. Its distinct-code count
**saturates after about two months** (283 codes, then +11–15 per further
window), so capturing all sixteen months contiguously would have cost ~60 more
tool calls for a thin seasonal tail. `lines_seen` is therefore a **sample**
count, not a census — it ranks a work list, it is not a purchase history.

## What the extract will not decide

- **A code with letters in the middle is never grouped.** Uncle Roy's
  `20036PR500` and `20036PR1000` are the same essence in two bottle sizes — two
  separate things to buy. Only `^[A-Za-z]{0,2} ?\d{2,}$` is treated as a
  spelling variant, which is the Brakes `33891` / `A 33891` / `A33891` case.
- **One code seen with two pack sizes is held for review** (143 of them).
  Usually the OCR dropped a case count — `40 x 250g` read as `250g` — and the
  pack drives how a PO is rounded, so the live error is a 40× one.
- **The same digits under two different prefixes is held for review.** Never
  happened in the captured year, but if `A123` and `C123` both appear the prefix
  is carrying meaning and merging them would fuse two products.

## What the import will not guess

- **Which product a code belongs to**, beyond a stock-code or exact-name match.
  A supplier describes goods its own way ("Wholesome Farms Unsalted Butter") and
  the venue counts them another ("Butter, unsalted"). A wrong fuzzy match welds
  a price and a pack to the wrong product and every later reorder for both is
  wrong with nothing on screen saying so. Unmatched codes are listed busiest
  first as a work list.
- **The numeric `supplier_pack_size`.** Brakes bills compactor sacks as `100x1`
  (a hundred sacks) and gloves as `1x100` (one box of a hundred) — the same
  shape meaning opposite things. The observed text is carried into the CSV for a
  human to read; the column is theirs to set.
- **A cost somebody already typed**, or a `priority`. Existing mappings are
  gap-filled only.

## The client's key-items workbook

`client-key-items.csv` is Rebecca's *Prospective SKUs for stock system* workbook
(Sheet1 + Phase 1 + Phase 2), flattened to one row per
`suggested_name / stock_item / sku / supplier` and committed here. It is the
closest thing to an answer key this exercise has: the client has written, per
invoice line, what they want the product called.

⚠️ **Its SKU column is misaligned on some rows and cannot be keyed on blindly.**
Cross-checked against the invoice lines those codes came from, 57 of 617
checkable rows name a SKU whose real description is nothing like the one beside
it, and 24 SKUs appear against two or more different products:

```
SKU 135575  sheet says "Brakes Med Eggs (Shell On)"
            invoices say "Noble Free Range Liquid Egg White"  (123 lines)
SKU 26089   sheet says "Brakes Med Eggs (Shell On) 15Dozen"
            invoices say "Vinyl Gloves Clear Lge PF GD09L"    (66 lines)
```

One code repeating under unrelated items is a column pasted a few rows out of
step, not a judgement anybody made. So `client-key-items.ts` uses a row's SKU
only where the row's own DESCRIPTION agrees with what the invoices say that code
is; where they disagree the description wins — that is what the client was
looking at when they wrote the name — and the SKU is dropped for that row.

The `source` column in `match-review.csv` records which of those applied:

| source | meaning |
|---|---|
| `client-sku` | the client's code AND wording agree with the invoices |
| `client-description` | the client's wording, their code contradicted or absent |
| `matched` | this repo's string matching; the client never mentioned it |
| `none` | nothing to go on — ADD ITEM or NOT STOCK |

## Applying the reviewed sheet

`match-review.csv` goes out for review; `match-review-decided.csv` is what came
back (17 Sept 2026), and it is committed so the run that produced the live
mappings is reproducible. The `decision` column takes four answers:

| decision | meaning |
|---|---|
| `Y` | accept `proposed_stock_code` |
| a stock code | no, THIS product — overrules the proposal |
| `ADD ITEM` | no product exists; create one from `new_product_name` + `new_stock_uom` |
| `NOT STOCK` | not a stock item (a delivery charge, a one-off tool) |

A blank is not a fifth answer. It is an unanswered question, and it is left
alone rather than guessed at.

```bash
npx tsx apps/api/scripts/import-invoice-skus.ts \
  --decisions=apps/api/data/invoice-skus/match-review-decided.csv --dry-run
```

Drop `--dry-run` to apply. Rules worth knowing before you read the output, all
in `src/modules/suppliers/invoice-sku-decisions.ts`:

- **Two rows may name one new product, and that makes ONE product.** Twist
  bills the same confetti as `6462` and `6462-4kg`; Booker and Makro both stock
  Strathmore Still Glass under `077549`. One product, several purchasable
  lines — which is exactly what `supplier_products` is for. Creating one
  product per row would rebuild the duplicate catalogue the September merge
  cleaned up.
- **An `ADD ITEM` whose name already exists is an ATTACH, not an insert**, for
  the same reason. This is also what makes the run **idempotent**: a second
  pass finds the products the first one made and attaches to them.
- **A placeholder name is refused, not created.** `UNKNOWN - "4 x 2.5kg"
  (check invoice)` reached the sheet from the client workbook's own name column
  and is a question, not a product.
- **The sheet carries no aliases and no last-seen date** — a reviewer should
  not have to preserve columns they are not judging. Those are rejoined from
  `supplier-skus.csv` on `(supplier, sku)`, and a decision for a code that is
  not in that file is refused rather than written from the sheet alone.
- **New products get a stock code, a name and a unit, and nothing else.** No
  purchase unit, no pack size, no cost — so every one of them lands on the
  Needs-setup list. The invoice cannot supply those honestly: its price is per
  PACK ("1 x 25kg" at £25.40), and putting that in `expected_next_cost` against
  a factor of 1 would price the ingredient at £25.40 **per kilo** in every
  recipe using it. The pack price goes where it is true — on the supplier line.

A refused row does not hold back the rows that resolved: those are written, the
refusals are listed, and the process exits non-zero so it cannot scroll past.

### ⚠️ The July-2026 supplier-catalogue rows

`import-supplier-catalogue.ts` ran on **2026-07-28** and wrote ~706
`supplier_products` rows across 29 suppliers. It predates the alias table
(migration 0052), so it filed **every spelling of a code as its own canonical
purchasable line**:

```
Brakes  149492 / A 149492 / A149492                  -> Ariel Laundry Powder  (3 rows)
Brakes  113654 / C 113654 / C113654
        128154 / C 128154 / C128154                  -> Long Life Soya Milk   (6 rows)
```

Those are not aliases in the schema's sense — they are buying options, and the
reorder engine ranks buying options against each other by pack size and price.
Five phantom Soya Milk lines can win an order.

Two consequences you will see in a decisions run:

- **alias conflicts** — the run tries to file `A 149492` as an alias of
  `149492` and finds it already sitting there as a canonical. Skipped, named,
  harmless: the canonical code still resolves.
- **codes skipped as already on another product** — `attachSupplierCode`
  refuses to add a second row for a code this supplier already uses elsewhere.

**Neither is caused by this importer; both are it declining to make the
existing problem worse.** The cleanup — fold the spelling variants into
`supplier_product_aliases` and resolve the ~35 codes sitting on two products —
is a separate job and is not attempted here, because picking which of two
products a code belongs to is a judgement, not a rule.

## Auditing what is already there

The import places codes; the audit checks the ones already placed.

```bash
npx tsx apps/api/scripts/audit-supplier-mappings.ts            # read-only
npx tsx apps/api/scripts/audit-supplier-mappings.ts --csv      # for a sheet
npx tsx apps/api/scripts/fix-supplier-mappings.ts              # DRY RUN
npx tsx apps/api/scripts/fix-supplier-mappings.ts --apply
```

Run 17 Sept 2026 against 1016 mappings: 33 contradicted, of which 18 real and
15 wording. The 18 are fixed — 9 surplus rows soft-deleted, 9 repointed — and
the audit now reports 15, all of them correct mappings the word-overlap check
cannot read.

`mapping-corrections.csv` settles anything the two safe shapes cannot, one row
per human decision, reason included, and outranks the reviewed sheet. Add a row
and re-run; `mapping-corrections.test.ts` asserts the file still parses, since
`readCorrectionsCsv` drops malformed rows rather than raising.
