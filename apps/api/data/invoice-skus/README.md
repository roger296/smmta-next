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
