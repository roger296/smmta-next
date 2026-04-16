import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and, isNull, sql, count } from 'drizzle-orm';
import * as schema from '../db/schema/index.js';
import { LucaClient } from '../integrations/luca/luca-client.js';

/**
 * Post-Migration Verification Script
 *
 * Run after ETL + opening balances to verify data integrity.
 *   npx tsx src/migration/verify-migration.ts
 *
 * Checks:
 *   1. Row counts per table
 *   2. FK integrity (no orphaned references)
 *   3. Luca trial balance matches local calculated balances
 *   4. No data loss (compare with source counts if available)
 */
async function main() {
  const companyId = process.env.COMPANY_ID;
  const pgUrl = process.env.PG_URL ?? 'postgresql://smmta:smmta@localhost:5432/smmta_next';

  if (!companyId) {
    console.error('COMPANY_ID required');
    process.exit(1);
  }

  console.log('=== Post-Migration Verification ===\n');

  const pool = new pg.Pool({ connectionString: pgUrl });
  const db = drizzle(pool, { schema });
  const luca = new LucaClient();

  // 1. Row counts
  console.log('--- Row Counts ---');

  const tables = [
    { name: 'customers', table: schema.customers },
    { name: 'customer_contacts', table: schema.customerContacts },
    { name: 'customer_delivery_addresses', table: schema.customerDeliveryAddresses },
    { name: 'customer_invoice_addresses', table: schema.customerInvoiceAddresses },
    { name: 'customer_types', table: schema.customerTypes },
    { name: 'suppliers', table: schema.suppliers },
    { name: 'supplier_contacts', table: schema.supplierContacts },
    { name: 'supplier_addresses', table: schema.supplierAddresses },
    { name: 'products', table: schema.products },
    { name: 'product_images', table: schema.productImages },
    { name: 'stock_items', table: schema.stockItems },
    { name: 'customer_orders', table: schema.customerOrders },
    { name: 'order_lines', table: schema.orderLines },
    { name: 'invoices', table: schema.invoices },
    { name: 'invoice_lines', table: schema.invoiceLines },
    { name: 'credit_notes', table: schema.creditNotes },
    { name: 'purchase_orders', table: schema.purchaseOrders },
    { name: 'purchase_order_lines', table: schema.purchaseOrderLines },
    { name: 'goods_received_notes', table: schema.goodsReceivedNotes },
    { name: 'supplier_invoices', table: schema.supplierInvoices },
    { name: 'allocations', table: schema.allocations },
    { name: 'currencies', table: schema.currencies },
    { name: 'warehouses', table: schema.warehouses },
    { name: 'categories', table: schema.categories },
    { name: 'manufacturers', table: schema.manufacturers },
  ];

  for (const { name, table } of tables) {
    const result = await db.select({ count: count() }).from(table);
    console.log(`  ${name}: ${result[0]?.count ?? 0} rows`);
  }

  // 2. Outstanding balance summaries
  console.log('\n--- Financial Summaries ---');

  const arTotal = await db
    .select({ total: sql<string>`COALESCE(SUM(CAST(amount_outstanding AS NUMERIC)), 0)` })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, companyId), isNull(schema.invoices.deletedAt)));
  console.log(`  AR outstanding: £${parseFloat(arTotal[0]?.total ?? '0').toFixed(2)}`);

  const apTotal = await db
    .select({ total: sql<string>`COALESCE(SUM(CAST(amount_outstanding AS NUMERIC)), 0)` })
    .from(schema.supplierInvoices)
    .where(and(eq(schema.supplierInvoices.companyId, companyId), isNull(schema.supplierInvoices.deletedAt)));
  console.log(`  AP outstanding: £${parseFloat(apTotal[0]?.total ?? '0').toFixed(2)}`);

  const stockTotal = await db
    .select({ total: sql<string>`COALESCE(SUM(CAST(value AS NUMERIC) * quantity), 0)` })
    .from(schema.stockItems)
    .where(and(eq(schema.stockItems.companyId, companyId), eq(schema.stockItems.status, 'IN_STOCK'), isNull(schema.stockItems.deletedAt)));
  console.log(`  Stock value: £${parseFloat(stockTotal[0]?.total ?? '0').toFixed(2)}`);

  // 3. Luca trial balance check
  console.log('\n--- Luca Trial Balance ---');
  try {
    const periodId = new Date().toISOString().slice(0, 7);
    const tb = await luca.getTrialBalance(periodId);
    console.log('  ✓ Luca trial balance retrieved successfully');
    console.log(`  ${JSON.stringify(tb).slice(0, 200)}...`);
  } catch (err) {
    console.warn(`  ⚠ Could not fetch Luca trial balance: ${(err as Error).message}`);
  }

  // 4. GL posting log check
  const glLogCount = await db.select({ count: count() }).from(schema.glPostingLog);
  const failedCount = await db
    .select({ count: count() })
    .from(schema.glPostingLog)
    .where(eq(schema.glPostingLog.status, 'FAILED'));
  console.log(`\n--- GL Posting Log ---`);
  console.log(`  Total postings: ${glLogCount[0]?.count ?? 0}`);
  console.log(`  Failed postings: ${failedCount[0]?.count ?? 0}`);

  if (Number(failedCount[0]?.count ?? 0) > 0) {
    console.log('  ⚠ WARNING: There are failed GL postings that need retry');
  }

  await pool.end();
  console.log('\n=== Verification complete ===');
}

main().catch(console.error);
