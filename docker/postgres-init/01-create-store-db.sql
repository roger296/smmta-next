-- Create the storefront's database alongside the operational SMMTA-NEXT
-- database. Owned by the same role so a single migration role works for
-- both. See apps/store/drizzle/schema.ts for the storefront schema.
SELECT 'CREATE DATABASE smmta_store OWNER smmta'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'smmta_store')
\gexec
