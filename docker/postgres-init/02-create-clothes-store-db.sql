-- Create the Clothes Shop storefront's database. It is separate from
-- smmta_store because each storefront drains its own email outbox and keeps its
-- own checkouts: sharing one database would have the Filament Store sending
-- clothes orders' emails under its own branding. Fresh volumes only; the API
-- entrypoint creates it on existing ones. See apps/store-clothes/drizzle/schema.ts.
SELECT 'CREATE DATABASE smmta_store_clothes OWNER smmta'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'smmta_store_clothes')
\gexec
