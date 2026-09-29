-- Book deliveries in against a purchase order (Sept 2026, supplier ordering).
--
-- A delivery rarely matches its order exactly: some lines arrive and others
-- follow later, a line comes short and the rest is back-ordered, or the
-- supplier sends more than was asked for. Each receipt therefore books what
-- ACTUALLY arrived against the order's lines, and whatever has not arrived
-- stays outstanding for a later receipt.
--
-- purchase_orders.site_id: the venue the order is for. Big Bakes receives into
--   venues (sites), not the inherited `warehouses`, and the per-site stock
--   ledger is what every report reads. Nullable: orders raised before this
--   have no venue, and the venue booking them in supplies it.
-- goods_in_receipts.purchase_order_id / delivery_note_number: which order a
--   delivery was booked against, and the supplier's own delivery-note number
--   (the thing a credit claim quotes back to them).
-- goods_in_receipt_lines.purchase_order_line_id: which order line a received
--   quantity counts towards. NULL for an item that arrived but was not on the
--   order at all.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites(id);
ALTER TABLE goods_in_receipts ADD COLUMN IF NOT EXISTS purchase_order_id uuid REFERENCES purchase_orders(id);
ALTER TABLE goods_in_receipts ADD COLUMN IF NOT EXISTS delivery_note_number varchar(100);
ALTER TABLE goods_in_receipt_lines ADD COLUMN IF NOT EXISTS purchase_order_line_id uuid REFERENCES purchase_order_lines(id);
CREATE INDEX IF NOT EXISTS goods_in_receipts_po_idx ON goods_in_receipts (purchase_order_id);
CREATE INDEX IF NOT EXISTS goods_in_receipt_lines_po_line_idx ON goods_in_receipt_lines (purchase_order_line_id);
CREATE INDEX IF NOT EXISTS purchase_orders_site_idx ON purchase_orders (site_id);
