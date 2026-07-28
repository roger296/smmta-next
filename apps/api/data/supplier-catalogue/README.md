# Supplier catalogue

Suppliers, their SKUs, and the products only the purchasing side knows about.

Source: **Rebecca's "Prospective SKUs for stock system" workbook**, `Main List`
tab. The other seven tabs are supplier price lists in different shapes, not
product→supplier mappings, and are ignored.

## Regenerating

```
python apps/api/scripts/extract-supplier-catalogue.py ["C:\path\to\book.xlsx"]
```

⚠️ Feed it the **xlsx**, never a Google Sheets export. Exporting that workbook
as one document concatenates all eight tabs into a single stream with four
different column layouts, which silently mixes price-list rows in with the
mappings.

## Importing

From the `stock-api` container terminal. The WORKDIR is the monorepo root, so
change directory first:

```
cd /app/apps/api && npx tsx scripts/import-supplier-catalogue.ts --dry-run
cd /app/apps/api && npx tsx scripts/import-supplier-catalogue.ts
```

Idempotent throughout — suppliers match on name, products on stock code,
mappings on the `(product, supplier, supplierSku)` unique index from migration
0037. Re-running after gaps are filled only adds.

## Placeholders

The sheet doesn't have everything, and the two columns it's missing are both
`NOT NULL`. Rather than drop those rows, they come in marked:

| Missing | Stands in as | Find them later |
|---|---|---|
| price | `£0.10` | `SELECT * FROM supplier_products WHERE cost_gbp = 0.10;` |
| supplier code | `NOSKU` | `SELECT * FROM supplier_products WHERE supplier_sku = 'NOSKU';` |

Both are deliberately conspicuous rather than zero or blank. `NOSKU` prints
as-is on a purchase order so it can't pass for a real code, and £0.10 survives
any "cost must be positive" check while being obviously not a real price.

**A `NOSKU` line is not orderable** until someone fills the real code in.

Note that `NOSKU` collapses duplicates: the identity is
`(product, supplier, supplierSku)`, so several unmarked rows for the same
product and supplier become one. That's correct — they're the same purchase
line seen on different invoices — but it's why the mapping count comes out
below the row count.

## Preferred supplier

Where a product has several suppliers, `priority` is assigned cheapest-first,
with placeholder-priced rows pushed to the back. Otherwise the rows we know
least about would look cheapest and win every time.

## Pack sizes

`supplier_pack_size` is only filled when the sheet's free-text pack could be
read with confidence — `1x1kg`, `2 x 5ltr`, `500g`. Anything like
`Box / Case` or `Pack of 100 x 7` is left null, and null is the safe answer:
the reorder engine falls back to a pack size of 1, whereas a wrong number
silently mis-sizes every future order of that item.
