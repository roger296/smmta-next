import { z } from 'zod';

/**
 * Configuration for the ETL migration from SQL Server (old SMMTA) to PostgreSQL (new).
 *
 * Reads from environment or CLI args. The SQL Server connection uses the
 * mssql npm package (must be installed: npm install mssql).
 */

export const etlConfigSchema = z.object({
  // Source: Old SMMTA SQL Server database
  MSSQL_SERVER: z.string(),
  MSSQL_DATABASE: z.string().default('SmoothAccounting'),
  MSSQL_USER: z.string(),
  MSSQL_PASSWORD: z.string(),
  MSSQL_PORT: z.coerce.number().default(1433),

  // Target: New PostgreSQL database
  PG_URL: z.string().default('postgresql://smmta:smmta@localhost:5432/smmta_next'),

  // Migration options
  COMPANY_ID: z.string().uuid().describe('The UUID for the company in the new system'),
  OLD_COMPANY_ID: z.coerce.number().describe('The CompanyId (bigint) from the old system'),
  BATCH_SIZE: z.coerce.number().default(500),
  DRY_RUN: z.coerce.boolean().default(false),
});

export type ETLConfig = z.infer<typeof etlConfigSchema>;

export function loadETLConfig(): ETLConfig {
  return etlConfigSchema.parse(process.env);
}

/**
 * Migration dependency order.
 * Tables must be imported in this order to satisfy foreign key constraints.
 */
export const MIGRATION_ORDER = [
  // Phase 1: Reference data (no FK dependencies)
  'currencies',
  'warehouses',
  'manufacturers',
  'categories',
  'customer_types',

  // Phase 2: Master data (depends on reference)
  'customers',
  'customer_contacts',
  'customer_delivery_addresses',
  'customer_invoice_addresses',
  'customer_notes',
  'customer_product_prices',

  'suppliers',
  'supplier_contacts',
  'supplier_addresses',
  'supplier_notes',

  'products',
  'product_images',
  'product_category_mappings',

  // Phase 3: Transactional data (depends on master)
  'purchase_orders',
  'purchase_order_lines',
  'goods_received_notes',
  'grn_lines',
  'stock_items',

  'customer_orders',
  'order_lines',
  'order_notes',

  'invoices',
  'invoice_lines',
  'credit_notes',
  'credit_note_lines',

  'supplier_invoices',
  'supplier_credit_notes',

  'allocations',
] as const;
