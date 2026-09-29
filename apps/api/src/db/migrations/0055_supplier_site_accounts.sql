-- Supplier accounts per site (Sept 2026, supplier-ordering groundwork).
--
-- A supplier knows each venue by its own account number, delivers to it on
-- its own days, and holds it to its own cut-off and minimum order. Those are
-- what let the ordering screen say "cheapest that ARRIVES before you run out",
-- not just "cheapest" (docs/plans/SUPPLIER_ORDERING_PLAN.md §3.2).
--
-- An account describes its deliveries one of two ways: a round
-- (delivery_days + cutoff_time + cutoff_days_before) or a lead time
-- (lead_days working days). Times are the site's wall clock.
--
-- No soft delete: is_active switches an account off, and the unique key keeps
-- one row per (supplier, site) whatever its state.
CREATE TABLE IF NOT EXISTS supplier_site_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  account_number varchar(60),
  edi_location_id varchar(60),
  delivery_days varchar(3)[] NOT NULL DEFAULT '{}',
  cutoff_time time,
  cutoff_days_before smallint NOT NULL DEFAULT 1,
  lead_days smallint,
  min_order_value numeric(12,2),
  delivery_charge numeric(12,2),
  free_delivery_over numeric(12,2),
  order_email varchar(200),
  portal_url varchar(500),
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT supplier_site_accounts_days_chk
    CHECK (delivery_days <@ ARRAY['MON','TUE','WED','THU','FRI','SAT','SUN']::varchar[]),
  CONSTRAINT supplier_site_accounts_cutoff_days_chk
    CHECK (cutoff_days_before BETWEEN 0 AND 14),
  CONSTRAINT supplier_site_accounts_lead_days_chk
    CHECK (lead_days IS NULL OR lead_days BETWEEN 0 AND 60)
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_site_accounts_company_supplier_site_unq
  ON supplier_site_accounts (company_id, supplier_id, site_id);
