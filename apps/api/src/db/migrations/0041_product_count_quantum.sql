-- Per-product counting quantum (Aug-2026 feedback, defect D-2).
--
-- The stock-take screen rounded EVERY non-discrete count to the nearest 100
-- stock units, from a blanket `quantum = 100` default in the client's
-- `bucketCount`. Across mixed units that is destructive, not tidy: a 4 kg count
-- of icing sugar submitted as **0**, and a 250 g count as 300. (It was masked
-- in production by defect D-1 — with no product map the UoM fell back to
-- `each`, which is discrete and never bucketed. Fixing D-1 removed the mask.)
--
-- Bucketing is only ever correct when the quantum is expressed in the
-- product's OWN stock unit and configured deliberately per product. So:
--
--   NULL (the default, and every existing row) ⇒ NO bucketing. The counted
--   figure is submitted exactly as entered.
--
-- Nullable rather than `DEFAULT 0` so "nobody has thought about this product"
-- and "this product is deliberately counted whole" stay distinguishable.
--
-- Deliberately NOT the full drizzle-generated diff: `db:generate` also
-- re-emitted the recipe-line, entry-mode and table-split changes, because the
-- hand-authored 0038/0039/0040 never regenerated a snapshot. Those are already
-- applied by those migrations, and re-running their un-guarded ADD COLUMNs
-- would fail. The accompanying 0041 snapshot DOES capture the full schema, so
-- the next `db:generate` diffs from the truth again.

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "count_quantum" numeric(18, 4);

-- A quantum of zero or below is not a smaller bucket, it is a divide-by-zero
-- waiting to happen. "No bucketing" is spelled NULL.
ALTER TABLE "products"
  DROP CONSTRAINT IF EXISTS "products_count_quantum_positive_ck";
ALTER TABLE "products"
  ADD CONSTRAINT "products_count_quantum_positive_ck" CHECK (
    "count_quantum" IS NULL OR "count_quantum" > 0
  );
