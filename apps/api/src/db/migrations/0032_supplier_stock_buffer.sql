-- Per-supplier stock buffer (Roger, 2026-09-14): a supplier item shows as
-- available, and can be ordered, only while the supplier reports more than
-- this many units. Default 5.
--
-- Divergence from the drop-shipping spec §4.2, which defines supplier free
-- stock as sum(last_known_stock): the storefront now subtracts this buffer
-- per mapping and ignores suppliers that are not taking drop-ship orders.
ALTER TABLE "suppliers" ADD COLUMN "stock_buffer" integer DEFAULT 5 NOT NULL;
