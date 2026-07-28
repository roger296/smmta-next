-- How a session's tables split across the dietary variants.
--
-- `covers` holds the TOTAL table count (see the note on that column). These
-- record how many of them were gluten-free and vegan; regular is the
-- remainder. Stored rather than derived because the expected quantities were
-- computed from this split at submit — without it, reopening a session to
-- amend it could not reproduce the numbers the baker was judged against.
--
-- Existing records predate dietary variants: every table was regular, so 0 is
-- the correct backfill rather than a placeholder.

ALTER TABLE "session_consumption"
  ADD COLUMN IF NOT EXISTS "gluten_free_tables" integer NOT NULL DEFAULT 0;

ALTER TABLE "session_consumption"
  ADD COLUMN IF NOT EXISTS "vegan_tables" integer NOT NULL DEFAULT 0;

-- The variants cannot exceed the total, and none of them can be negative.
ALTER TABLE "session_consumption"
  DROP CONSTRAINT IF EXISTS "session_consumption_table_split_ck";
ALTER TABLE "session_consumption"
  ADD CONSTRAINT "session_consumption_table_split_ck" CHECK (
    "gluten_free_tables" >= 0
    AND "vegan_tables" >= 0
    AND "gluten_free_tables" + "vegan_tables" <= "covers"
  );
