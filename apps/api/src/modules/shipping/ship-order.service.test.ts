/**
 * Shipping an order, against a real database.
 *
 * Covers what has to be true before the button works, everything shipping
 * changes (stock, order, invoice, event, invoice PDF), that it cannot happen
 * twice, the combined print file, and the shipped email hand-off.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  customerDeliveryAddresses,
  customerOrders,
  customers,
  domainEvents,
  invoiceLines,
  invoices,
  orderLines,
  products,
  shippingLabels,
  stockItems,
  warehouses,
} from '../../db/schema/index.js';
import { wipeCompany } from '../../../test/fixtures/stock.js';
import { InvoiceDocumentService } from '../orders/invoice-document.service.js';
import { InvoiceService } from '../orders/invoice.service.js';
import { DispatchEmailRejectedError, sendDispatchEmail } from './dispatch-email.js';
import { PickNoteService } from './pick-note.service.js';
import { ShipOrderError, ShipOrderService } from './ship-order.service.js';
import { ShippingLabelService } from './shipping-label.service.js';

const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-09-11T10:00:00.000Z');

let dir: string;
let customerId: string;
let addressId: string;
let productId: string;
let warehouseId: string;
let seq = 0;

const services = () => {
  const labels = new ShippingLabelService({ labelsDir: dir, enabled: false });
  const pickNotes = new PickNoteService({ dir: join(dir, 'pick-notes') });
  const invoiceDocs = new InvoiceDocumentService({ dir: join(dir, 'invoices') });
  return { pickNotes, invoiceDocs, ship: new ShipOrderService({ labels, pickNotes, invoiceDocs, now: () => NOW }) };
};

/**
 * An order shaped like a storefront order: 2 × £12.28 inc VAT, £4.95 delivery
 * inc VAT, charged £29.51.
 */
async function makeOrder(opts: { allocate?: boolean; label?: boolean; pickNote?: boolean; sourceChannel?: 'API' | 'MANUAL' | 'AMAZON' } = {}) {
  const { allocate = true, label = true, pickNote = true, sourceChannel = 'API' } = opts;
  const db = getDb();
  seq++;
  const [order] = await db
    .insert(customerOrders)
    .values({
      companyId: COMPANY_ID,
      orderNumber: `TEST-SHIP-${seq}`,
      customerId,
      deliveryAddressId: addressId,
      orderDate: '2026-09-10',
      status: 'ALLOCATED',
      sourceChannel,
      orderTotal: '24.56',
      taxTotal: '4.91',
      deliveryCharge: '4.95',
      grandTotal: '29.51',
      trackingLink: 'https://app.smoothparcel.com/trackmyshipments/A1B2-C3D4',
      integrationMetadata: { mollie: { status: 'paid' } },
    })
    .returning();
  const orderId = order!.id;
  await db.insert(orderLines).values({
    orderId,
    productId,
    quantity: 2,
    pricePerUnit: '12.28',
    lineTotal: '24.56',
    taxRate: 20,
    taxValue: '4.09',
  });
  for (let i = 0; i < 2; i++) {
    await db.insert(stockItems).values({
      companyId: COMPANY_ID,
      productId,
      warehouseId,
      status: allocate ? 'ALLOCATED' : 'IN_STOCK',
      salesOrderId: allocate ? orderId : null,
    });
  }
  if (label) {
    const labelFile = `${randomUUID()}.pdf`;
    const doc = await PDFDocument.create();
    doc.addPage([288, 432]);
    await writeFile(join(dir, labelFile), Buffer.from(await doc.save()));
    await db.insert(shippingLabels).values({
      companyId: COMPANY_ID,
      orderId,
      idempotencyKey: `SMOOTH_PARCEL:order:${orderId}`,
      status: 'CREATED',
      providerOrderCode: '555001',
      trackingNumber: 'A1B2-C3D4',
      labelPath: labelFile,
      responsePayload: { IsSuccess: true, ShipmentCode: 555001, ShipingMethodProviderName: 'Evri' },
    });
  }
  if (pickNote) await services().pickNotes.generate(orderId, COMPANY_ID);
  return orderId;
}

async function cleanup() {
  const db = getDb();
  const invs = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.companyId, COMPANY_ID));
  if (invs.length > 0) await db.delete(invoiceLines).where(inArray(invoiceLines.invoiceId, invs.map((i) => i.id)));
  await db.delete(invoices).where(eq(invoices.companyId, COMPANY_ID));
  await db.delete(domainEvents).where(eq(domainEvents.companyId, COMPANY_ID));
  await wipeCompany(COMPANY_ID);
  const cs = await db.select({ id: customers.id }).from(customers).where(eq(customers.companyId, COMPANY_ID));
  if (cs.length > 0) {
    const ids = cs.map((c) => c.id);
    await db.delete(customerDeliveryAddresses).where(inArray(customerDeliveryAddresses.customerId, ids));
    await db.delete(customers).where(inArray(customers.id, ids));
  }
}

beforeAll(async () => {
  await cleanup();
  dir = await mkdtemp(join(tmpdir(), 'smmta-ship-test-'));
  const db = getDb();
  const [cust] = await db.insert(customers).values({ companyId: COMPANY_ID, name: 'Roger Test', email: 'buyer@ship.invalid' }).returning();
  customerId = cust!.id;
  const [addr] = await db
    .insert(customerDeliveryAddresses)
    .values({ customerId, contactName: 'Roger Test', line1: 'Close Cottage', city: 'Stoke-on-Trent', postCode: 'ST7 3PL', country: 'GB' })
    .returning();
  addressId = addr!.id;
  const [product] = await db
    .insert(products)
    .values({ companyId: COMPANY_ID, name: 'Landau PLA Basic 1.75mm 1kg — Brown', stockCode: 'TEST-SHIP-BROWN' })
    .returning();
  productId = product!.id;
  const [wh] = await db.insert(warehouses).values({ companyId: COMPANY_ID, name: 'Ship test warehouse' }).returning();
  warehouseId = wh!.id;
});

afterAll(async () => {
  await cleanup();
  await rm(dir, { recursive: true, force: true });
  await closeDatabase();
});

describe('ShipOrderService.readiness', () => {
  it('lists everything that stands in the way', async () => {
    const orderId = await makeOrder({ allocate: false, label: false, pickNote: false });
    const r = await services().ship.readiness(orderId, COMPANY_ID);
    expect(r).toMatchObject({ ready: false, alreadyShipped: false, hasLabel: false, hasPickNote: false, allocated: false });
    expect(r.reasons.join(' ')).toMatch(/shipping label/);
    expect(r.reasons.join(' ')).toMatch(/pick note/);
    expect(r.reasons.join(' ')).toMatch(/Allocate stock: 0 of 2 units of TEST-SHIP-BROWN allocated/);
  });

  it('is ready once the order has a label, a pick note and all its stock allocated', async () => {
    const orderId = await makeOrder();
    expect(await services().ship.readiness(orderId, COMPANY_ID)).toMatchObject({ ready: true, reasons: [] });
  });

  it('refuses to ship an order that is not ready, saying why', async () => {
    const orderId = await makeOrder({ label: false });
    const err = await services().ship.ship(orderId, COMPANY_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShipOrderError);
    expect((err as ShipOrderError).reasons).toContain('Create the shipping label.');
  });
});

describe('ShipOrderService.ship', () => {
  it('ships the order: stock sold, order shipped with courier and tracking, invoice and event created', async () => {
    const orderId = await makeOrder();
    const { ship, invoiceDocs } = services();
    const result = await ship.ship(orderId, COMPANY_ID);

    expect(result).toMatchObject({ status: 'SHIPPED', shippedDate: '2026-09-11', courierName: 'Evri', trackingNumber: 'A1B2-C3D4', invoicePdfError: null });

    const db = getDb();
    const [order] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
    expect(order).toMatchObject({ status: 'SHIPPED', courierName: 'Evri', trackingNumber: 'A1B2-C3D4' });
    expect(String(order!.shippedDate)).toBe('2026-09-11');

    const stock = await db.select().from(stockItems).where(eq(stockItems.salesOrderId, orderId));
    expect(stock.map((s) => [s.status, s.bookedOutDate])).toEqual([
      ['SOLD', '2026-09-11'],
      ['SOLD', '2026-09-11'],
    ]);

    // Net, VAT and gross as an invoice must state them: VAT is not added twice.
    const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, orderId));
    expect(invoice).toMatchObject({ lineTotal: '20.47', taxTotal: '4.91', deliveryCharge: '4.13', grandTotal: '29.51' });
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice!.id));
    expect(line).toMatchObject({ pricePerUnit: '10.24', lineTotal: '20.47', taxValue: '4.09' });

    const events = await db
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.companyId, COMPANY_ID), eq(domainEvents.eventType, 'order.dispatched'), eq(domainEvents.aggregateId, orderId)));
    expect(events).toHaveLength(1);

    expect(invoice!.pdfUrl).toMatch(/\.pdf$/);
    const pdf = await invoiceDocs.readPdf(invoice!.id, COMPANY_ID);
    expect(pdf?.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf?.filename).toBe(`invoice-${invoice!.invoiceNumber}.pdf`);
  });

  it('cannot ship the same order twice', async () => {
    const orderId = await makeOrder();
    const { ship } = services();
    await ship.ship(orderId, COMPANY_ID);
    await expect(ship.ship(orderId, COMPANY_ID)).rejects.toThrow(/already been shipped/);
    const invs = await getDb().select().from(invoices).where(eq(invoices.orderId, orderId));
    expect(invs).toHaveLength(1);
  });

  it('keeps an invoice made by hand before shipping, rather than billing twice', async () => {
    const orderId = await makeOrder();
    await new InvoiceService().createFromOrder(orderId, COMPANY_ID, 'test-user', { dateOfInvoice: '2026-09-10' });
    const { ship } = services();
    expect((await ship.readiness(orderId, COMPANY_ID)).ready).toBe(true);
    await ship.ship(orderId, COMPANY_ID);
    expect(await getDb().select().from(invoices).where(eq(invoices.orderId, orderId))).toHaveLength(1);
  });
});

describe('dispatch documents', () => {
  it('combines the pick note and label into one PDF, pick note first', async () => {
    const orderId = await makeOrder();
    const file = await services().ship.dispatchDocuments(orderId, COMPANY_ID);
    expect(file?.filename).toMatch(/^dispatch-TEST-SHIP-\d+\.pdf$/);
    const combined = await PDFDocument.load(file!.buffer);
    const sizes = combined.getPages().map((p) => [p.getWidth(), p.getHeight()]);
    expect(sizes[0]).toEqual([288, 288]);
    expect(sizes[sizes.length - 1]).toEqual([288, 432]);
  });

  it('is unavailable without a label', async () => {
    const orderId = await makeOrder({ label: false });
    expect(await services().ship.dispatchDocuments(orderId, COMPANY_ID)).toBeNull();
  });
});

describe('sendDispatchEmail', () => {
  const deps = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl, storeBaseUrl: 'http://store.test', storeKey: 'key' });

  it('hands the storefront the customer, courier, tracking and order number', async () => {
    const orderId = await makeOrder();
    await services().ship.ship(orderId, COMPANY_ID);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    expect(await sendDispatchEmail(orderId, COMPANY_ID, deps(fetchMock as unknown as typeof fetch))).toBe('sent');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://store.test/api/internal/order-status');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key');
    expect(JSON.parse(String(init.body))).toMatchObject({
      orderId,
      status: 'SHIPPED',
      orderNumber: expect.stringMatching(/^TEST-SHIP-/),
      customerEmail: 'buyer@ship.invalid',
      customerFirstName: 'Roger',
      courierName: 'Evri',
      trackingNumber: 'A1B2-C3D4',
      trackingLink: 'https://app.smoothparcel.com/trackmyshipments/A1B2-C3D4',
      shippedDate: '11 September 2026',
    });
  });

  it('does not email a marketplace order', async () => {
    const orderId = await makeOrder({ sourceChannel: 'AMAZON' });
    await services().ship.ship(orderId, COMPANY_ID);
    const fetchMock = vi.fn();
    expect(await sendDispatchEmail(orderId, COMPANY_ID, deps(fetchMock as unknown as typeof fetch))).toBe('marketplace-order');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a storefront outage but not a refusal', async () => {
    const orderId = await makeOrder({ sourceChannel: 'MANUAL' });
    await services().ship.ship(orderId, COMPANY_ID);
    const outage = vi.fn(async () => new Response('down', { status: 503 }));
    const refusal = vi.fn(async () => new Response('{"error":"Invalid body"}', { status: 400 }));

    const outageErr = await sendDispatchEmail(orderId, COMPANY_ID, deps(outage as unknown as typeof fetch)).catch((e: unknown) => e);
    expect(outageErr).toBeInstanceOf(Error);
    expect(outageErr).not.toBeInstanceOf(DispatchEmailRejectedError);

    const refusalErr = await sendDispatchEmail(orderId, COMPANY_ID, deps(refusal as unknown as typeof fetch)).catch((e: unknown) => e);
    expect(refusalErr).toBeInstanceOf(DispatchEmailRejectedError);
  });
});
