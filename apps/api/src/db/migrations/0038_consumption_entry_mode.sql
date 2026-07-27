-- Let a consumption line be entered as "what's left" instead of "what was used".
--
-- Per line, not per session: some ingredients are far easier to weigh at the
-- end than to track as they go. `actual_qty` stays the canonical consumed
-- figure either way — in REMAINING mode it is the derived opening − remaining.
--
-- opening_qty and remaining_qty are stored rather than recomputed on demand:
-- stock keeps moving, so deriving `opening − remaining` a week later would
-- silently produce a different number. Keeping both also preserves what the
-- baker actually typed, so an audit can tell "4 used" from "16 left" instead
-- of seeing only the derived result.
--
-- Existing rows were all entered as consumption, which is what the default
-- backfills them to.

ALTER TABLE "session_consumption_lines"
  ADD COLUMN IF NOT EXISTS "entry_mode" varchar(12) NOT NULL DEFAULT 'CONSUMED';

ALTER TABLE "session_consumption_lines"
  ADD COLUMN IF NOT EXISTS "opening_qty" numeric(18, 3);

ALTER TABLE "session_consumption_lines"
  ADD COLUMN IF NOT EXISTS "remaining_qty" numeric(18, 3);

-- Only the two modes exist, and REMAINING lines must carry the pair they were
-- derived from. A REMAINING row with a null opening would be a consumed figure
-- nobody can re-check.
ALTER TABLE "session_consumption_lines"
  DROP CONSTRAINT IF EXISTS "session_consumption_lines_entry_mode_ck";
ALTER TABLE "session_consumption_lines"
  ADD CONSTRAINT "session_consumption_lines_entry_mode_ck" CHECK (
    ("entry_mode" = 'CONSUMED')
    OR ("entry_mode" = 'REMAINING' AND "opening_qty" IS NOT NULL AND "remaining_qty" IS NOT NULL)
  );
