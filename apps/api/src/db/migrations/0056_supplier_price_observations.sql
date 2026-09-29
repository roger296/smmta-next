-- Supplier price observations (Sept 2026, supplier-ordering groundwork).
--
-- Every price seen for a buying option, append-only, with its source and date
-- (docs/plans/SUPPLIER_ORDERING_PLAN.md §3.3). supplier_products.cost_gbp is a
-- single undated number: a July import looks as current as yesterday's
-- invoice, and one bad OCR read silently replaces a good price. With the
-- history, a price shows its age and source, a move shows as a move, and an
-- odd read can be outvoted.
--
-- unit_price is per ONE of what the supplier bills under that code (the
-- mapping's unit), not per stock unit.
--
-- source_key makes an import re-runnable: the same invoice line always
-- produces the same key, and the partial unique index turns a second run into
-- a no-op.
DO $$ BEGIN
  CREATE TYPE price_observation_source AS ENUM
    ('INVOICE', 'PO_CONFIRMED', 'GOODS_IN', 'QUOTE_API', 'CATALOGUE_FILE', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS supplier_price_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  supplier_product_id uuid NOT NULL REFERENCES supplier_products(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  source price_observation_source NOT NULL,
  unit_price numeric(18,6) NOT NULL,
  currency_code varchar(3) NOT NULL DEFAULT 'GBP',
  quantity numeric(18,3),
  pack_seen varchar(120),
  observed_at timestamptz NOT NULL,
  document_ref varchar(120),
  source_key varchar(300),
  note varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_price_obs_positive_chk CHECK (unit_price > 0)
);
CREATE INDEX IF NOT EXISTS supplier_price_obs_latest_idx
  ON supplier_price_observations (supplier_product_id, observed_at);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_price_obs_source_key_unq
  ON supplier_price_observations (company_id, source, source_key)
  WHERE source_key IS NOT NULL;
