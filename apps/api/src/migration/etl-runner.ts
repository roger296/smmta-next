import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema/index.js';
import { loadETLConfig, MIGRATION_ORDER, type ETLConfig } from './etl-config.js';

/**
 * ETL Runner — Migrates data from old SQL Server SMMTA to new PostgreSQL.
 *
 * Run: MSSQL_SERVER=... MSSQL_USER=... MSSQL_PASSWORD=... \
 *      COMPANY_ID=... OLD_COMPANY_ID=... \
 *      npx tsx src/migration/etl-runner.ts
 *
 * This script:
 *   1. Connects to both old (MSSQL) and new (PG) databases
 *   2. For each table in MIGRATION_ORDER, extracts from MSSQL, transforms, loads to PG
 *   3. Maintains old_id mapping for cross-referencing
 *   4. Only imports OPEN/UNPAID transactional data (not closed history)
 *
 * NOTE: Requires `mssql` package: npm install mssql
 *       The mssql import is dynamic to keep it optional for runtime.
 */

// Old-to-new ID mapping maintained across the run
const idMap = new Map<string, Map<number, string>>();

function getNewId(table: string, oldId: number): string | undefined {
  return idMap.get(table)?.get(oldId);
}

function setNewId(table: string, oldId: number, newId: string) {
  if (!idMap.has(table)) idMap.set(table, new Map());
  idMap.get(table)!.set(oldId, newId);
}

async function main() {
  const config = loadETLConfig();
  console.log('=== SMMTA Data Migration ETL ===\n');
  console.log(`Source: ${config.MSSQL_SERVER}/${config.MSSQL_DATABASE}`);
  console.log(`Target: ${config.PG_URL}`);
  console.log(`Company: old=${config.OLD_COMPANY_ID} → new=${config.COMPANY_ID}`);
  console.log(`Dry run: ${config.DRY_RUN}\n`);

  // Connect to source (SQL Server)
  const mssql = await import('mssql' as string);
  const sqlPool = await mssql.default.connect({
    server: config.MSSQL_SERVER,
    database: config.MSSQL_DATABASE,
    user: config.MSSQL_USER,
    password: config.MSSQL_PASSWORD,
    port: config.MSSQL_PORT,
    options: { encrypt: false, trustServerCertificate: true },
  });
  console.log('✓ Connected to SQL Server\n');

  // Connect to target (PostgreSQL)
  const pgPool = new pg.Pool({ connectionString: config.PG_URL });
  const db = drizzle(pgPool, { schema });
  console.log('✓ Connected to PostgreSQL\n');

  // Run migrations in order
  for (const table of MIGRATION_ORDER) {
    try {
      console.log(`--- Migrating: ${table} ---`);
      const count = await migrateTable(table, sqlPool, db, config);
      console.log(`  ✓ ${count} rows migrated\n`);
    } catch (err) {
      console.error(`  ✗ Failed: ${(err as Error).message}\n`);
    }
  }

  // Cleanup
  await sqlPool.close();
  await pgPool.end();
  console.log('=== Migration complete ===');
}

async function migrateTable(
  table: string,
  sqlPool: any,
  db: any,
  config: ETLConfig,
): Promise<number> {
  // Table-specific SQL queries and transformations
  const migrators: Record<string, () => Promise<number>> = {

    currencies: async () => {
      const rows = await sqlPool.request().query('SELECT * FROM Currencies WHERE Deleted = 0');
      let count = 0;
      for (const row of rows.recordset) {
        if (config.DRY_RUN) { count++; continue; }
        const [inserted] = await db.insert(schema.currencies).values({
          code: row.CurrencyCode?.trim() || `CUR${row.CurrencyID}`,
          name: row.CurrencyName || row.CurrencyCode || 'Unknown',
          symbol: row.CurrencySymbol,
          exchangeRateToBase: row.ExchangeRate?.toString() ?? '1',
          oldId: row.CurrencyID,
        }).returning();
        setNewId('currencies', row.CurrencyID, inserted.id);
        count++;
      }
      return count;
    },

    warehouses: async () => {
      const rows = await sqlPool.request()
        .input('companyId', config.OLD_COMPANY_ID)
        .query('SELECT * FROM Warehouses WHERE CompanyId = @companyId AND Deleted = 0');
      let count = 0;
      for (const row of rows.recordset) {
        if (config.DRY_RUN) { count++; continue; }
        const [inserted] = await db.insert(schema.warehouses).values({
          companyId: config.COMPANY_ID,
          name: row.WarehouseName || 'Unnamed Warehouse',
          addressLine1: row.AddressLine1,
          addressLine2: row.AddressLine2,
          city: row.City,
          region: row.Region,
          postCode: row.PostCode,
          country: row.Country,
          isDefault: row.IsDefault ?? false,
          oldId: row.WarehouseID,
        }).returning();
        setNewId('warehouses', row.WarehouseID, inserted.id);
        count++;
      }
      return count;
    },

    manufacturers: async () => {
      const rows = await sqlPool.request().query('SELECT * FROM Manufacturers WHERE Deleted = 0');
      let count = 0;
      for (const row of rows.recordset) {
        if (config.DRY_RUN) { count++; continue; }
        const [inserted] = await db.insert(schema.manufacturers).values({
          name: row.ManufacturerName || 'Unknown',
          description: row.ManufacturerDescription,
          logoUrl: row.LogoImage,
          website: row.WebSiteLink,
          oldId: row.ManufacturerID,
        }).returning();
        setNewId('manufacturers', row.ManufacturerID, inserted.id);
        count++;
      }
      return count;
    },

    categories: async () => {
      const rows = await sqlPool.request()
        .input('companyId', config.OLD_COMPANY_ID)
        .query('SELECT * FROM Categories WHERE CompanyId = @companyId AND Deleted = 0');
      let count = 0;
      for (const row of rows.recordset) {
        if (config.DRY_RUN) { count++; continue; }
        const [inserted] = await db.insert(schema.categories).values({
          companyId: config.COMPANY_ID,
          name: row.CategoryName || 'Unnamed',
          oldId: row.CategoryID,
        }).returning();
        setNewId('categories', row.CategoryID, inserted.id);
        count++;
      }
      return count;
    },

    customer_types: async () => {
      const rows = await sqlPool.request()
        .input('companyId', config.OLD_COMPANY_ID)
        .query('SELECT * FROM CustomerTypes WHERE CompanyId = @companyId AND Deleted = 0');
      let count = 0;
      for (const row of rows.recordset) {
        if (config.DRY_RUN) { count++; continue; }
        const [inserted] = await db.insert(schema.customerTypes).values({
          companyId: config.COMPANY_ID,
          name: row.CustomerTypeName || 'Default',
          isDefault: (row as any)['Default'] ?? false,
          oldId: row.CustomerTypeID,
        }).returning();
        setNewId('customer_types', row.CustomerTypeID, inserted.id);
        count++;
      }
      return count;
    },

    customers: async () => {
      const rows = await sqlPool.request()
        .input('companyId', config.OLD_COMPANY_ID)
        .query('SELECT * FROM Customers WHERE CompanyId = @companyId AND Deleted = 0');
      let count = 0;
      for (const row of rows.recordset) {
        if (config.DRY_RUN) { count++; continue; }
        const [inserted] = await db.insert(schema.customers).values({
          companyId: config.COMPANY_ID,
          name: row.CustomerName || 'Unknown',
          shortName: row.CustomerShortName,
          typeId: row.CustomerTypeID ? getNewId('customer_types', row.CustomerTypeID) : undefined,
          email: row.CustomerEmailAddress,
          creditLimit: row.CreditLimit?.toString() ?? '0',
          creditTermDays: row.CreditTermDays ?? 30,
          taxRatePercent: '20',
          vatTreatment: 'STANDARD_VAT_20',
          vatRegistrationNumber: row.VATregistrationNum,
          companyRegistrationNumber: row.CompanyRegistrationNumber,
          countryCode: row.CountryCode,
          oldId: row.CustomerID,
        }).returning();
        setNewId('customers', row.CustomerID, inserted.id);
        count++;
      }
      return count;
    },

    suppliers: async () => {
      const rows = await sqlPool.request()
        .input('companyId', config.OLD_COMPANY_ID)
        .query('SELECT * FROM Suppliers WHERE CompanyId = @companyId AND Deleted = 0');
      let count = 0;
      for (const row of rows.recordset) {
        if (config.DRY_RUN) { count++; continue; }
        const [inserted] = await db.insert(schema.suppliers).values({
          companyId: config.COMPANY_ID,
          name: row.SupplierName || 'Unknown',
          type: row.SupplierType,
          email: row.SupplierEmailAddress,
          website: row.SupplierWebSite,
          creditLimit: row.CreditLimit?.toString() ?? '0',
          creditTermDays: row.CreditTermDays ?? 30,
          vatTreatment: 'STANDARD_VAT_20',
          vatRegistrationNumber: row.VATregistrationNum,
          countryCode: row.CountryCode,
          oldId: row.SupplierID,
        }).returning();
        setNewId('suppliers', row.SupplierID, inserted.id);
        count++;
      }
      return count;
    },

    products: async () => {
      const rows = await sqlPool.request()
        .input('companyId', config.OLD_COMPANY_ID)
        .query('SELECT * FROM Products WHERE CompanyId = @companyId AND Deleted = 0');
      let count = 0;
      for (const row of rows.recordset) {
        if (config.DRY_RUN) { count++; continue; }
        const mfrId = row.ManufacturerID ? getNewId('manufacturers', row.ManufacturerID) : undefined;
        const whId = row.DefaultWarehouseId ? getNewId('warehouses', row.DefaultWarehouseId) : undefined;

        const [inserted] = await db.insert(schema.products).values({
          companyId: config.COMPANY_ID,
          name: row.ProductName || 'Unknown Product',
          stockCode: row.StockCode,
          manufacturerId: mfrId,
          manufacturerPartNumber: row.ManufacturerPartNumber,
          description: row.Description,
          expectedNextCost: row.ExpectedNextCost?.toString() ?? '0',
          minSellingPrice: row.MinSellingPrice?.toString(),
          maxSellingPrice: row.MaxSellingPrice?.toString(),
          ean: row.EAN,
          productType: row.IsService ? 'SERVICE' : 'PHYSICAL',
          requireSerialNumber: row.RequireSerialNumber ?? false,
          weight: row.Weight?.toString(),
          countryOfOrigin: row.CountryOfOrigin,
          hsCode: row.HSCode,
          defaultWarehouseId: whId,
          marketplaceIdentifiers: {
            sellerSkus: [row.SellerSKU1, row.SellerSKU2, row.SellerSKU3].filter(Boolean),
            asins: [row.ASIN1, row.ASIN2, row.ASIN3].filter(Boolean),
            fnskus: [row.FNSKU1, row.FNSKU2, row.FNSKU3].filter(Boolean),
          },
          oldId: row.ProductID,
        }).returning();
        setNewId('products', row.ProductID, inserted.id);
        count++;
      }
      return count;
    },

    // Remaining tables follow the same extract-transform-load pattern.
    // Each maps old FK values via getNewId() and stores new UUIDs via setNewId().
    // For brevity, these are stubbed — implement the same pattern for:
    //   customer_contacts, customer_delivery_addresses, customer_invoice_addresses,
    //   customer_notes, customer_product_prices, supplier_contacts, supplier_addresses,
    //   supplier_notes, product_images, product_category_mappings,
    //   purchase_orders, purchase_order_lines, goods_received_notes, grn_lines,
    //   stock_items, customer_orders, order_lines, order_notes,
    //   invoices, invoice_lines, credit_notes, credit_note_lines,
    //   supplier_invoices, supplier_credit_notes, allocations

    customer_contacts: async () => stubMigrate('CustomerContacts', 'CustomerID', sqlPool, config),
    customer_delivery_addresses: async () => stubMigrate('CustomerDeliveryAddresses', 'CustomerID', sqlPool, config),
    customer_invoice_addresses: async () => stubMigrate('CustomerInvoiceAddresses', 'CustomerID', sqlPool, config),
    customer_notes: async () => stubMigrate('CustomerNotes', 'CustomerID', sqlPool, config),
    customer_product_prices: async () => stubMigrate('CustomerProductPrices', 'CompanyId', sqlPool, config),
    supplier_contacts: async () => stubMigrate('SupplierContacts', 'SupplierID', sqlPool, config),
    supplier_addresses: async () => stubMigrate('SupplierAddresses', 'SupplierID', sqlPool, config),
    supplier_notes: async () => stubMigrate('NotesLogs', null, sqlPool, config),
    product_images: async () => stubMigrate('ProductImages', 'ProductID', sqlPool, config),
    product_category_mappings: async () => stubMigrate('ProductCategoryMappings', null, sqlPool, config),
    purchase_orders: async () => stubMigrate('PurchaseOrders', 'CompanyId', sqlPool, config),
    purchase_order_lines: async () => stubMigrate('PurchaseOrderContentsLines', null, sqlPool, config),
    goods_received_notes: async () => stubMigrate('GoodsReceivedNotes', 'CompanyId', sqlPool, config),
    grn_lines: async () => stubMigrate('GoodsReceivedNoteContentLines', null, sqlPool, config),
    stock_items: async () => stubMigrate('StockItems', 'CompanyId', sqlPool, config),
    customer_orders: async () => stubMigrate('CustomerOrders', 'CompanyId', sqlPool, config),
    order_lines: async () => stubMigrate('OrderContentsLines', null, sqlPool, config),
    order_notes: async () => stubMigrate('OrderNotes', null, sqlPool, config),
    invoices: async () => stubMigrate('Invoices', 'CompanyId', sqlPool, config),
    invoice_lines: async () => stubMigrate('InvoiceContentsLines', null, sqlPool, config),
    credit_notes: async () => stubMigrate('CreditNotes', 'CompanyId', sqlPool, config),
    credit_note_lines: async () => stubMigrate('CreditNoteContentsLines', null, sqlPool, config),
    supplier_invoices: async () => stubMigrate('SupplierInvoices', 'CompanyId', sqlPool, config),
    supplier_credit_notes: async () => stubMigrate('SupplierCreditNotes', 'CompanyId', sqlPool, config),
    allocations: async () => stubMigrate('Allocations', 'CompanyId', sqlPool, config),
  };

  const migrator = migrators[table];
  if (!migrator) {
    console.log(`  ⏭ No migrator defined for ${table}`);
    return 0;
  }

  return migrator();
}

/** Stub for tables that follow the standard pattern but need specific column mapping. */
async function stubMigrate(
  oldTable: string,
  companyColumn: string | null,
  sqlPool: any,
  config: ETLConfig,
): Promise<number> {
  const where = companyColumn
    ? `WHERE ${companyColumn} = ${config.OLD_COMPANY_ID} AND Deleted = 0`
    : 'WHERE Deleted = 0';
  const result = await sqlPool.request().query(`SELECT COUNT(*) AS cnt FROM ${oldTable} ${where}`);
  const count = result.recordset[0].cnt;
  console.log(`  → ${oldTable}: ${count} rows to migrate (implement column mapping)`);
  return 0; // Stubbed — implement per-table column mapping
}

main().catch(console.error);
