-- Goods-in lines remember their batch (Sept 2026, supplier-ordering groundwork).
--
-- A batch-tracked delivery tops up `stock_batches`, but the receipt line never
-- said WHICH lot it went into. Undoing the receipt therefore reversed the
-- stock movement and left the lot's quantity standing: the ledger said the
-- flour had gone, the use-by report still listed it, and FEFO would try to
-- consume from a lot that no longer existed.
--
-- The line now carries the code and use-by it was booked under, so a reversal
-- can take exactly that quantity back off exactly that lot. Nullable: lines
-- booked before this migration have no record of their lot, and their
-- reversal leaves batches alone, as it always did.
ALTER TABLE goods_in_receipt_lines ADD COLUMN IF NOT EXISTS batch_code varchar(100);
ALTER TABLE goods_in_receipt_lines ADD COLUMN IF NOT EXISTS use_by date;
