# June count catalogue

The product catalogue derived from the June 2026 stock-count list — the things
venues physically count — ready for `scripts/import-catalogue.ts`.

These files are committed deliberately. The production stock database is not
reachable from outside the VPS (correctly), so the import runs inside the
`stock-api` container; shipping the CSV in the image means no file transfer and
makes the import reproducible from a clean deploy.

| file | what it is |
|---|---|
| `products.csv` | 364 products — the import input |
| `source-count-list.csv` | the operator's reconciled count list (386 lines), for traceability |
| `extract-report.txt` | what the extractor merged, and why |

## Running the import

From the Coolify **stock-api** terminal. The container's WORKDIR is the
monorepo root (`/app`), so `cd` into the api workspace first — otherwise tsx
looks for `/app/scripts/...` and fails with ERR_MODULE_NOT_FOUND.

Dry run first — it writes nothing:

```
cd /app/apps/api
npx tsx scripts/import-catalogue.ts --dir=data/count-catalogue
npx tsx scripts/import-catalogue.ts --dir=data/count-catalogue --apply
```

Safe to re-run: products key on `stock_code`, so a second run reports
everything unchanged. Nothing is ever deleted — a product missing from the CSV
is left alone, so a partial file cannot wipe the catalogue.

## Regenerating

When the count list changes, re-export it as CSV and (from `apps/api`):

```
npx tsx scripts/extract-count-list.ts \
  --in=<count-list.csv> --out-dir=data/count-catalogue \
  --units=<purchasing products.csv>   # optional
```

Then re-run the import. Read `extract-report.txt` afterwards: it lists every
case where two count lines collapsed into one product, which is usually right
(the same item counted in two areas) but occasionally exposes a bad match.
