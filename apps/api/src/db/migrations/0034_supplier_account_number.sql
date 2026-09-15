-- Our account (customer) number with a supplier, e.g. Uneek's TBV02 (Roger,
-- 2026-09-15). Uneek refused the first live drop-ship order without it
-- ("CustomerNONotFound"), and its product data endpoint needs it too. It is
-- set on the admin Drop-ship tab, not in server settings. NULL = not set.
ALTER TABLE "suppliers" ADD COLUMN "account_number" varchar(60);
