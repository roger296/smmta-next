/**
 * Importing orders from a file in the legacy layout, end to end against a
 * real database: the warehouse is matched by name, both addresses are kept,
 * the courier and the sender's reference land on the order, an unknown
 * product code rejects the whole order, and a repeat of the same reference
 * is skipped rather than duplicated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  customerDeliveryAddresses,
  customerInvoiceAddresses,
  customerOrders,
  customers,
  products,
  warehouses,
} from '../../db/schema/index.js';
import { wipeCompany } from '../../../test/fixtures/stock.js';
import { CSVImportService } from '../../modules/orders/csv-import.service.js';

const COMPANY_ID = '77777777-7777-4777-8777-777777777777';
const USER_ID = '77777777-7777-4777-8777-000000000001';

const HEADER =
  'Order Id,Order Date(dd/mm/yyyy),Customer Name,Email Address,Customer Contact,Courier Name,Warehouse Name,' +
  'Tax to be (Exclusive/Inclusive),Delivery Charge,Product Code,Quantity,Price,Tax Rate,' +
  'Contact Name For Delivery Address,Address Line 1 For Delivery Address,City For Delivery Address,' +
  'Post Code For Delivery Address,Country For Delivery Address,' +
  'Contact Name For Invoice Address,Address Line 1 For Invoice Address,City For Invoice Address,' +
  'Post Code For Invoice Address,Country For Invoice Address';

const row = (orderId: string, sku: string, qty = '1') =>
  `${orderId},21/09/2026,Jane Example,jane-${COMPANY_ID.slice(0, 4)}@example.invalid,07700 900123,Royal Mail,main,` +
  `Inclusive,3.95,${sku},${qty},9.99,20,` +
  `Jane Example,1 High Street,Newtown,AB1 2CD,United Kingdom,` +
  `Accounts,2 Office Row,Oldtown,ZY9 8XW,United Kingdom`;

const service = new CSVImportService();

async function cleanup() {
  const db = getDb();
  await wipeCompany(COMPANY_ID);
  const owned = await db.select({ id: customers.id }).from(customers).where(eq(customers.companyId, COMPANY_ID));
  if (owned.length > 0) {
    const ids = owned.map((c) => c.id);
    await db.delete(customerDeliveryAddresses).where(inArray(customerDeliveryAddresses.customerId, ids));
    await db.delete(customerInvoiceAddresses).where(inArray(customerInvoiceAddresses.customerId, ids));
  }
  await db.delete(customers).where(eq(customers.companyId, COMPANY_ID));
}

beforeAll(async () => {
  await cleanup();
  const db = getDb();
  await db.insert(warehouses).values({ companyId: COMPANY_ID, name: 'Main', isDefault: true });
  await db.insert(products).values([
    { companyId: COMPANY_ID, name: 'Widget', stockCode: 'ABC-1', productType: 'PHYSICAL' },
    { companyId: COMPANY_ID, name: 'Gadget', stockCode: 'ABC-2', productType: 'PHYSICAL' },
  ]);
});

afterAll(async () => {
  await cleanup();
  await closeDatabase();
});

describe('legacy CSV order import', () => {
  it('creates the order with its warehouse, addresses, courier and reference', async () => {
    const csv = [HEADER, row('1001', 'ABC-1', '2'), row('1001', 'ABC-2')].join('\r\n');
    const result = await service.importFromCSV(COMPANY_ID, USER_ID, csv);

    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(1);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]!.thirdPartyOrderId).toBe('1001');
    expect(result.orders[0]!.orderNumber).toMatch(/^SO-\d{6}$/);

    const order = await getDb().query.customerOrders.findFirst({
      where: eq(customerOrders.id, result.orders[0]!.orderId),
      with: { lines: true, customer: true, deliveryAddress: true, invoiceAddress: true, warehouse: true },
    });
    expect(order).toBeDefined();
    expect(order!.thirdPartyOrderId).toBe('1001');
    expect(order!.customerOrderNumber).toBe('1001');
    expect(order!.sourceChannel).toBe('CSV');
    expect(order!.status).toBe('CONFIRMED');
    expect(order!.courierName).toBe('Royal Mail');
    expect(order!.taxInclusive).toBe(true);
    expect(order!.orderDate).toBe('2026-09-21');
    expect(order!.deliveryCharge).toBe('3.95');
    expect(order!.warehouse?.name).toBe('Main');
    expect(order!.customer.name).toBe('Jane Example');
    expect(order!.deliveryAddress?.line1).toBe('1 High Street');
    expect(order!.deliveryAddress?.phone).toBe('07700 900123');
    expect(order!.invoiceAddress?.line1).toBe('2 Office Row');
    expect(order!.lines.map((l) => l.quantity).sort()).toEqual([1, 2]);
  });

  it('skips a reference it has already imported', async () => {
    const result = await service.importFromCSV(COMPANY_ID, USER_ID, [HEADER, row('1001', 'ABC-1')].join('\n'));
    expect(result).toMatchObject({ imported: 0, skipped: 1, errors: [], orders: [] });
  });

  it('rejects an order naming a product code it does not know, and imports nothing of it', async () => {
    const csv = [HEADER, row('1002', 'ABC-1'), row('1002', 'NOPE-9')].join('\n');
    const result = await service.importFromCSV(COMPANY_ID, USER_ID, csv);
    expect(result.imported).toBe(0);
    expect(result.errors).toEqual([{ thirdPartyOrderId: '1002', error: 'Unknown product code(s): NOPE-9' }]);
    const rows = await getDb().select().from(customerOrders).where(eq(customerOrders.thirdPartyOrderId, '1002'));
    expect(rows).toHaveLength(0);
  });

  it('rejects an order naming a warehouse it does not have', async () => {
    const csv = [HEADER, row('1003', 'ABC-1').replace(',main,', ',Nowhere,')].join('\n');
    const result = await service.importFromCSV(COMPANY_ID, USER_ID, csv);
    expect(result.errors).toEqual([{ thirdPartyOrderId: '1003', error: 'Unknown warehouse "Nowhere"' }]);
  });
});
