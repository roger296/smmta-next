-- Cost precision and pack description (Aug-2026 feedback, C-1/C-2/C-4).
--
-- C-4: "Icing sugar ... £0.00". `expected_next_cost` was numeric(18,2), but
-- ingredients are genuinely priced in fractions of a penny per gram — icing
-- sugar at ~£0.0012/g. Every such price rounded to 0.00 at rest, so every
-- venue cost read as zero and every line value computed from it was zero too.
-- Recipe `unit_cost` is already numeric(18,4); the two disagreed and this was
-- the shallower (locked decision 4 widens to 6dp, which covers per-gram
-- pricing with room to spare).
--
-- WIDENING IS LOSSLESS. numeric(18,2) -> numeric(18,6) adds decimal places;
-- every existing value round-trips unchanged. The precision that was already
-- lost at write time cannot be recovered here — those products need their real
-- prices entering, which is what the F9 "needs setup" report is for.
--
-- C-1/C-2: `pack_description` is how the purchase unit reads to a human —
-- "25 kg sack", "case of 6 × 1.6 kg". `purchase_uom` alone is a token
-- ("sack"); this is the phrase a baker checking a delivery note recognises.
-- Free text on purpose: the shapes suppliers ship in do not enumerate.

ALTER TABLE "products" ALTER COLUMN "expected_next_cost" SET DATA TYPE numeric(18, 6);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "expected_next_cost" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "pack_description" varchar(120);