-- The email address on our account with a supplier (Roger, 2026-09-15): for
-- Uneek, the one used to sign in to its website (roger@tbv-3pl.com). Uneek
-- refused orders carrying our general contact address with
-- "CustomerNONotFound" even with the account number sent, so orders to a
-- supplier with this set carry it in place of SUPPLIER_ORDER_CONTACT_EMAIL
-- (whether Uneek matches the customer on it is unconfirmed). Set on the admin
-- Drop-ship tab. Not the existing accounts_email, which is the supplier's own
-- accounts department. NULL = use the general contact address.
ALTER TABLE "suppliers" ADD COLUMN "customer_account_email" varchar(200);
