-- Who counted what, and who opened the take (Sept 2026).
--
-- Two people now count the same take at once, on separate iPads, each signed in
-- as themselves. Each must see what the other has saved - and whose number it
-- is - so that a line nobody touched stands out, and a line two people counted
-- differently can be settled at the shelf rather than discovered on the
-- variance report.
--
-- WHY A NAME AS WELL AS AN ID
-- The id is what the screen compares ("is this mine?"). The name is what it
-- shows. It is copied at the moment of the count, not joined live, because a
-- PIN label can be renamed or the PIN deleted, and a count must go on saying
-- who made it. `counted_by_user_id` is varchar, not uuid: a PIN token's user
-- id is `pin:<uuid>`, and an email user's is a bare uuid.
--
-- Both nullable: every line counted before this migration has no counter, and
-- saying "unknown" is truer than inventing one.
ALTER TABLE stock_take_lines ADD COLUMN IF NOT EXISTS counted_by_user_id varchar(100);
ALTER TABLE stock_take_lines ADD COLUMN IF NOT EXISTS counted_by_name varchar(120);

ALTER TABLE stock_takes ADD COLUMN IF NOT EXISTS opened_by_user_id varchar(100);
ALTER TABLE stock_takes ADD COLUMN IF NOT EXISTS opened_by_name varchar(120);
