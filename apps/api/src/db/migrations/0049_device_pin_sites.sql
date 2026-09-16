-- Head bakers who work at more than one venue (Sept-2026 user testing, item 1).
--
-- "We set a PIN per user which locks the user to a single location - some head
--  bakers work at two locations, so we need to consider having a system that
--  defaults to a single location but has the option to add extra locations
--  where the head baker could work. I would like to add this as a feature that
--  the user (head baker) can add him or herself."
--
-- `device_pins.site_id` STAYS as the home venue — the one the PIN defaults to
-- and the one every existing token already carries. This table holds the extra
-- venues, so a PIN with no extras behaves in every respect as it does today.
--
-- Each row is also the audit entry (owner's decision: self-service, logged and
-- reversible). It records when the venue was added and by whom, and deleting
-- the row is the revoke — head office does not need a separate log to read or
-- a separate mechanism to undo it.
CREATE TABLE IF NOT EXISTS "device_pin_sites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "device_pin_id" uuid NOT NULL REFERENCES "device_pins"("id") ON DELETE CASCADE,
  "site_id" uuid NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
  -- Who asked for it. 'SELF' is the baker adding their own venue from the iPad;
  -- 'ADMIN' is head office granting it. Kept apart because they answer
  -- different questions when somebody reviews the list later.
  "added_via" varchar(10) DEFAULT 'SELF' NOT NULL,
  "added_by" varchar(200),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);

-- Adding the same venue twice is a double-tap, not a second grant.
CREATE UNIQUE INDEX IF NOT EXISTS "device_pin_sites_pin_site_unq"
  ON "device_pin_sites" ("device_pin_id", "site_id");
CREATE INDEX IF NOT EXISTS "device_pin_sites_pin_idx"
  ON "device_pin_sites" ("device_pin_id");
