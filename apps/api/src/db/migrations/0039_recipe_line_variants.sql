-- Dietary variants on recipe lines.
--
-- Big Bakes needs to record what changes for a gluten-free or vegan guest:
-- which ingredients come out of the standard recipe, and what goes in instead.
-- Rather than a parallel table, each line carries which list it belongs to.
--
-- ⚠️ THE UNIQUE INDEX MUST WIDEN. A "remove for gluten free" line names a
-- product that is ALREADY in the base recipe — that is what a removal means —
-- so (recipe_id, product_id) would reject it. Every existing line is BASE.

ALTER TABLE "recipe_lines"
  ADD COLUMN IF NOT EXISTS "variant" varchar(16) NOT NULL DEFAULT 'BASE';

ALTER TABLE "recipe_lines"
  DROP CONSTRAINT IF EXISTS "recipe_lines_recipe_product_unq";
DROP INDEX IF EXISTS "recipe_lines_recipe_product_unq";

CREATE UNIQUE INDEX IF NOT EXISTS "recipe_lines_recipe_product_variant_unq"
  ON "recipe_lines" ("recipe_id", "product_id", "variant");

ALTER TABLE "recipe_lines"
  DROP CONSTRAINT IF EXISTS "recipe_lines_variant_ck";
ALTER TABLE "recipe_lines"
  ADD CONSTRAINT "recipe_lines_variant_ck" CHECK (
    "variant" IN ('BASE', 'GF_REMOVE', 'GF_ADD', 'VEGAN_REMOVE', 'VEGAN_ADD')
  );
