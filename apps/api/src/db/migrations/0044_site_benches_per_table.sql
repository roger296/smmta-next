-- Benches per table, per site (Aug-2026 feedback, F-7).
--
-- "Request to show benches under the kilo figures." Bakers set up and count in
-- benches; the recipe and the session are in tables. The tester's stated
-- reason is interruption recovery — coming back to a half-finished bake and
-- being able to see, without tapping anything, how much of it is done.
--
-- Per-site because the rooms differ, and NULLABLE because "nobody has told us
-- yet" and "this site has 6" are different facts. The UI says which it is
-- rather than quietly assuming a default (human task 5 is to set these).

ALTER TABLE "sites" ADD COLUMN "benches_per_table" numeric(6, 2);