# Suppliers from the invoices

Every supplier BumbleBee's analysed purchase invoices show Big Bakes actually
paying for stock.

Source: the BumbleBee MCP tool `bumblebee_invoice_suppliers(category="stock")`,
exported to **`bumblebee-invoice-suppliers.json`** on 2026-08-21 and committed
here so the extract is reproducible without a BumbleBee API key.

## Why this exists alongside `../supplier-catalogue/`

They come from opposite directions and both are needed.

| | `supplier-catalogue/` | `invoice-suppliers/` (this) |
|---|---|---|
| Source | Rebecca's workbook | BumbleBee's analysed invoices |
| Is | the list someone wrote out | the list the bank statement proves |
| Suppliers | 29 | 86 |
| Also carries | SKUs, pack sizes, prices | nothing but the name |

The workbook's 29 are all present here under the same spelling. The **43 extra**
suppliers this brings in account for roughly **£119,000 of stock spend** — about
a fifth of what Big Bakes buys had no row to raise a purchase order against.
The biggest are Twist Ingredients (£37.7k), Young & Co (£22.7k), SP Colour Mill
(£12.7k), Uncle Roy's (£8.0k) and Pact Coffee (£5.0k).

## Regenerating

```
python apps/api/scripts/extract-invoice-suppliers.py
```

Re-run the MCP tool and overwrite `bumblebee-invoice-suppliers.json` first if
you want fresher figures.

## Importing

From the `stock-api` container terminal. The WORKDIR is the monorepo root, so
change directory first:

```
cd /app/apps/api && npx tsx scripts/import-invoice-suppliers.ts --dry-run
cd /app/apps/api && npx tsx scripts/import-invoice-suppliers.ts
```

Order does not matter relative to `import-supplier-catalogue.ts` — both match
suppliers by name and neither overwrites the other.

## What it will and won't touch

**It never overwrites.** An invoice knows less about a supplier than the
operator who set one up by hand — it has a name and nothing else. An existing
row is only ever gap-filled: a blank `slug` or `type` gets one, anything already
written is left alone. Re-running is a no-op.

Matching is case-insensitive, because the invoices say `makro` where the
catalogue says `Makro` and an exact match would create a second one.

## Nothing here is orderable yet

An invoice proves a supplier exists, what was bought and what it cost. It
carries **no email, no account number, no lead time, no credit terms**. So every
supplier created here arrives without a way to order from it, and a PO cannot
be sent until someone fills that in.

The import ends by listing them ranked by spend, so the gap is a work list
rather than a surprise at the point of ordering. Start at the top: five emails
covers £160k of spend. Fill them in at `/suppliers`.

Lead times and credit terms are deliberately left at their schema defaults
rather than guessed — a wrong lead time quietly mis-times every future reorder
proposal for that supplier, and nothing in the invoice data implies one.

## The long tail

`suppliers-review.csv` holds 14 suppliers back: those under **£100** of spend
*and* fewer than **three** invoices. That is a volume test, not a judgement
about which businesses are "really" suppliers — one big invoice is a real
supplier (SP Colour Mill, £12,723 on a single invoice) and so is a corner shop
used ten times for emergency milk. It exists because a 90-row dropdown of which
14 are one-off coffees is worse to work with than a 72-row one.

Import them too if you want the complete list:

```
cd /app/apps/api && npx tsx scripts/import-invoice-suppliers.ts --include-review
```

## Names that were and weren't merged

Merged, from an explicit list in the extractor — never fuzzy-matched, because
"Cater 4 You" and "Cater for you" are one firm but "Sysco" and "Brakes" are two
despite Sysco owning Brakes, and no similarity score knows the difference:

`Cater for you` → `Cater 4 You` · `J M Posner` → `JMPosner` ·
`Sainsburys` and `Sainsbury's - Sainsbury's - S2029` → `Sainsbury's` ·
`CUPSDIRECT.CO.UK` → `Cups Direct Catering Supplies` ·
`The Drink Supermarket Team` → `Drink Supermarket` · plus casing fixes
(`makro`, `rainbow dust`, `classeq`, `archer`, `craft company`, `Ebay`).

**Not** merged, listed for a human to decide — being wrong here silently splits
or fuses a spend history:

- `Cake Decorating` vs `The Cake Decorating Co`
- `Cake Decorating` vs `Cake Craft Group`
- `Drinkstuff` vs `Drink Supermarket`
