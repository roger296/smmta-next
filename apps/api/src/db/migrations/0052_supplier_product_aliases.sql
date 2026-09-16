-- Alternative spellings of a supplier's code for one mapping (Sept 2026).
--
-- Invoice OCR returns the same Brakes code as "33891", "A 33891" and "A33891"
-- across invoices. All three must FIND the mapping — otherwise the next
-- invoice line fails to match and somebody re-keys it — but only one of them
-- is the code you quote back to Brakes.
--
-- WHY A SEPARATE TABLE, NOT MORE `supplier_products` ROWS
-- Every row in `supplier_products` is a PURCHASABLE LINE: it carries its own
-- pack size and price, and the reorder engine compares those rows to choose
-- what to buy. Brakes 33891 @ 1×25 kg and 114953 @ 6×1.5 kg are genuinely two
-- lines. "A33891" is not a third thing to buy — it is the first one spelled
-- differently, and as a row it would look like an extra option with the same
-- pack, which reordering could pick or double-count.
--
-- WHY `supplier_id` IS DENORMALISED ONTO THE ALIAS
-- The uniqueness that matters is "for THIS supplier, this code resolves to one
-- thing". That cannot be expressed on supplier_product_id alone, and a code
-- resolving to two mappings would make invoice matching ambiguous in exactly
-- the case this table exists to fix.
CREATE TABLE IF NOT EXISTS supplier_product_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  supplier_product_id uuid NOT NULL REFERENCES supplier_products(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  alias_sku varchar(200) NOT NULL,
  -- Where it came from. An OCR-derived alias is worth reviewing; one somebody
  -- typed is not. Kept apart because they answer different questions later.
  source varchar(20) NOT NULL DEFAULT 'MANUAL',
  -- When an invoice last carried this spelling, so a dead variant can be aged
  -- out rather than kept forever.
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Case-insensitive, live rows only: a retired alias's spelling is reusable.
CREATE UNIQUE INDEX IF NOT EXISTS supplier_product_aliases_supplier_sku_unq
  ON supplier_product_aliases (supplier_id, lower(alias_sku))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS supplier_product_aliases_mapping_idx
  ON supplier_product_aliases (supplier_product_id);
