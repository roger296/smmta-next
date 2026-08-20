-- Remove `sites.benches_per_table` (Aug-2026 feedback, F-7 — corrected).
--
-- 0044 added this column on a misreading. F-7 asked to "show benches under the
-- kilo figures", which was read as a request for a SECOND unit alongside
-- tables, and a per-site conversion ratio was built to translate between them.
--
-- There is no second unit. **A bench and a table are the same thing** — two
-- words for one object, "bench" being the word used in the venue and "table"
-- the word used in the spec and the recipe model. The ratio was therefore a
-- conversion factor between a thing and itself, and any value entered would
-- have made the screen read "4 of 5 tables · approximately 24 tables".
--
-- Confirmed by the owner, 20 Aug 2026. The bench count the tester asked for is
-- already derived from the quantity and the per-bench recipe amount; it needed
-- displaying, not converting.
--
-- Safe to drop: the column shipped on 20 Aug and was never populated — the
-- go-live step that would have set it was stopped before it ran.

ALTER TABLE "sites" DROP COLUMN IF EXISTS "benches_per_table";
