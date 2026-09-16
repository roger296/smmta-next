-- The supplier's own code for how an order should be sent (Roger, 2026-09-16),
-- e.g. Uneek's "DPD". It was the UNEEK_DELIVERY_METHOD env var; per-supplier
-- values belong on the supplier record, editable on the admin Drop-ship tab.
-- NULL or empty sends a blank field, which Uneek accepts (it then chose DPD).
ALTER TABLE "suppliers" ADD COLUMN "delivery_method_code" varchar(60);
