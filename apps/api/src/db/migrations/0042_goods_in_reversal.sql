-- Goods-in reversal (Aug-2026 feedback, defect E-3).
--
-- "Accidental booking logged 100kg to Birmingham; requested an undo timer or
-- role-based permission locks."
--
-- A mis-booking is corrected by a REVERSING RECEIPT — a new, audited,
-- ledger-balancing movement with mirrored negative stock movements — never by
-- mutating or deleting the original (locked decision 6). These columns link
-- the pair in both directions so either row explains itself, and carry who
-- asked for the reversal and why.
--
-- Deliberately NOT foreign keys to `goods_in_receipts`: the pair is written
-- inside one transaction, and a self-referential FK in both directions is a
-- chicken-and-egg on insert. The link is maintained by GoodsInService.reverse,
-- which is the only writer.

ALTER TABLE "goods_in_receipts" ADD COLUMN "reversal_of_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "goods_in_receipts" ADD COLUMN "reversed_by_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "goods_in_receipts" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "goods_in_receipts" ADD COLUMN "reversed_by_user_id" varchar(200);--> statement-breakpoint
ALTER TABLE "goods_in_receipts" ADD COLUMN "reversal_reason" text;--> statement-breakpoint
CREATE INDEX "goods_in_receipts_reversal_idx" ON "goods_in_receipts" USING btree ("reversal_of_receipt_id");