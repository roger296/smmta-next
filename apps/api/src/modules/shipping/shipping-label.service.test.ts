/**
 * Shipping label purchase against a real database, with the carrier faked.
 *
 * The property under test is that a label is never bought twice. A label costs
 * money and this runs from a retrying job, so the tests that matter most are
 * the ones where something fails halfway and is tried again.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  customerDeliveryAddresses,
  customerOrders,
  customers,
  orderLines,
  products,
  shippingLabels,
} from '../../db/schema/index.js';
import { wipeCompany } from '../../../test/fixtures/stock.js';
import { SmoothParcelUnreadableOrderError } from '../../integrations/smooth-parcel/smooth-parcel-client.js';
import { ShippingLabelConflictError, ShippingLabelService } from './shipping-label.service.js';

const COMPANY_ID = '77777777-7777-4777-8777-777777777777';
const PDF = Buffer.from('%PDF-1.4\n% test label\n');

function fakeCarrier(opts: { failLabelTimes?: number } = {}) {
  let labelFailuresLeft = opts.failLabelTimes ?? 0;
  const calls = { addNewOrder: 0, getShipmentLabel: 0 };
  const client = {
    async addNewOrder() {
      calls.addNewOrder++;
      return { orderCode: '555001', trackingNumber: 'A1B2-C3D4', raw: { OrderCode: 555001 } };
    },
    async getShipmentLabel() {
      calls.getShipmentLabel++;
      if (labelFailuresLeft > 0) {
        labelFailuresLeft--;
        throw new Error('label service unavailable');
      }
      return PDF;
    },
  };
  return { calls, client };
}

let labelsDir: string;
let customerId: string;
let productId: string;
let seq = 0;

async function makeOrder(opts: { postCode?: string | null } = {}): Promise<string> {
  const db = getDb();
  seq++;
  const [addr] = await db
    .insert(customerDeliveryAddresses)
    .values({
      customerId,
      contactName: 'Roger Test',
      line1: 'Close Cottage',
      line2: 'Mow Lane',
      city: 'Stoke-on-Trent',
      postCode: opts.postCode === undefined ? 'ST7 3PL' : opts.postCode,
      country: 'GB',
      phone: '07700 900123',
    })
    .returning();
  const [order] = await db
    .insert(customerOrders)
    .values({
      companyId: COMPANY_ID,
      orderNumber: `TEST-LABEL-${seq}`,
      customerId,
      deliveryAddressId: addr!.id,
      orderDate: '2026-09-10',
    })
    .returning();
  await db.insert(orderLines).values({
    orderId: order!.id,
    productId,
    quantity: 2,
    pricePerUnit: '12.28',
    lineTotal: '24.56',
    taxRate: 20,
    taxValue: '4.09',
  });
  return order!.id;
}

async function cleanup() {
  const db = getDb();
  const cs = await db.select({ id: customers.id }).from(customers).where(eq(customers.companyId, COMPANY_ID));
  await db.delete(shippingLabels).where(eq(shippingLabels.companyId, COMPANY_ID));
  // Orders, their lines, stock and products for the company.
  await wipeCompany(COMPANY_ID);
  if (cs.length > 0) {
    const ids = cs.map((c) => c.id);
    await db.delete(customerDeliveryAddresses).where(inArray(customerDeliveryAddresses.customerId, ids));
    await db.delete(customers).where(inArray(customers.id, ids));
  }
}

beforeAll(async () => {
  await cleanup();
  labelsDir = await mkdtemp(join(tmpdir(), 'smmta-labels-test-'));
  const db = getDb();
  const [cust] = await db
    .insert(customers)
    .values({ companyId: COMPANY_ID, name: 'Roger Test', email: 'roger@labels.invalid' })
    .returning();
  customerId = cust!.id;
  const [product] = await db
    .insert(products)
    .values({
      companyId: COMPANY_ID,
      name: 'Label Test Spool',
      stockCode: 'TEST-LABEL-SPOOL',
      weight: '1.000',
      length: '20.00',
      width: '20.00',
      height: '8.00',
    })
    .returning();
  productId = product!.id;
});

afterAll(async () => {
  await cleanup();
  await rm(labelsDir, { recursive: true, force: true });
  await closeDatabase();
});

const service = (client: ReturnType<typeof fakeCarrier>['client'], enabled = true) =>
  new ShippingLabelService({ client, labelsDir, enabled });

describe('ShippingLabelService.requestLabel', () => {
  it('records DISABLED and buys nothing when Smooth Parcel is switched off', async () => {
    const orderId = await makeOrder();
    const carrier = fakeCarrier();
    const label = await service(carrier.client, false).requestLabel(orderId, COMPANY_ID);
    expect(label.status).toBe('DISABLED');
    expect(label.hasLabelFile).toBe(false);
    expect(carrier.calls).toEqual({ addNewOrder: 0, getShipmentLabel: 0 });
  });

  it('buys the label, stores the PDF and puts tracking on the order', async () => {
    const orderId = await makeOrder();
    const carrier = fakeCarrier();
    const svc = service(carrier.client);
    const label = await svc.requestLabel(orderId, COMPANY_ID);

    expect(label.status).toBe('CREATED');
    expect(label.trackingNumber).toBe('A1B2-C3D4');
    expect(label.hasLabelFile).toBe(true);
    expect(carrier.calls).toEqual({ addNewOrder: 1, getShipmentLabel: 1 });

    const file = await svc.readLabelFile(orderId, COMPANY_ID);
    expect(file?.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(file?.filename).toMatch(/^label-TEST-LABEL-\d+\.pdf$/);

    const [order] = await getDb()
      .select({ trackingNumber: customerOrders.trackingNumber })
      .from(customerOrders)
      .where(eq(customerOrders.id, orderId));
    expect(order?.trackingNumber).toBe('A1B2-C3D4');
  });

  it('never buys a second label for an order that already has one', async () => {
    const orderId = await makeOrder();
    const carrier = fakeCarrier();
    const svc = service(carrier.client);
    await svc.requestLabel(orderId, COMPANY_ID);
    const again = await svc.requestLabel(orderId, COMPANY_ID);
    expect(again.status).toBe('CREATED');
    expect(carrier.calls).toEqual({ addNewOrder: 1, getShipmentLabel: 1 });
  });

  it('resumes after a failed label fetch without creating a second shipment', async () => {
    // The costly failure: the carrier accepted (and charged for) the shipment,
    // then the PDF fetch failed. A retry must fetch that label, not buy another.
    const orderId = await makeOrder();
    const carrier = fakeCarrier({ failLabelTimes: 1 });
    const svc = service(carrier.client);

    await expect(svc.requestLabel(orderId, COMPANY_ID)).rejects.toThrow('label service unavailable');
    const failed = await svc.latestForOrder(orderId, COMPANY_ID);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.providerOrderCode).toBe('555001');
    expect(failed?.retryCount).toBe(1);

    const retried = await svc.requestLabel(orderId, COMPANY_ID);
    expect(retried.status).toBe('CREATED');
    expect(carrier.calls.addNewOrder).toBe(1);
    expect(carrier.calls.getShipmentLabel).toBe(2);
  });

  it('records bad address data as FAILED without calling the carrier or throwing', async () => {
    const orderId = await makeOrder({ postCode: null });
    const carrier = fakeCarrier();
    const label = await service(carrier.client).requestLabel(orderId, COMPANY_ID);
    expect(label.status).toBe('FAILED');
    expect(label.errorMessage).toMatch(/postcode/);
    expect(carrier.calls).toEqual({ addNewOrder: 0, getShipmentLabel: 0 });
  });

  it('keeps one label row per order however many times it is requested', async () => {
    const orderId = await makeOrder();
    const svc = service(fakeCarrier().client, false);
    await svc.requestLabel(orderId, COMPANY_ID);
    await svc.requestLabel(orderId, COMPANY_ID);
    const rows = await getDb().select({ id: shippingLabels.id }).from(shippingLabels).where(eq(shippingLabels.orderId, orderId));
    expect(rows).toHaveLength(1);
  });

  it('uses the label that comes back with the shipment, without asking again', async () => {
    const orderId = await makeOrder();
    const calls = { addNewOrder: 0, getShipmentLabel: 0, downloadLabel: 0 };
    const client = {
      async addNewOrder() {
        calls.addNewOrder++;
        return { orderCode: '555002', trackingNumber: 'B1C2-D3E4', labelPath: 'Labels/555002.pdf', raw: {} };
      },
      async getShipmentLabel() {
        calls.getShipmentLabel++;
        return PDF;
      },
      async downloadLabel(path: string) {
        calls.downloadLabel++;
        expect(path).toBe('Labels/555002.pdf');
        return PDF;
      },
    };
    const label = await new ShippingLabelService({ client, labelsDir, enabled: true }).requestLabel(orderId, COMPANY_ID);
    expect(label.status).toBe('CREATED');
    expect(calls).toEqual({ addNewOrder: 1, getShipmentLabel: 0, downloadLabel: 1 });

    const [order] = await getDb()
      .select({ trackingLink: customerOrders.trackingLink })
      .from(customerOrders)
      .where(eq(customerOrders.id, orderId));
    expect(order?.trackingLink).toBe('https://app.smoothparcel.com/trackmyshipments/B1C2-D3E4');
  });

  it('never resends a shipment whose reply could not be read', async () => {
    // Smooth Parcel said yes but we could not read an order code: the shipment
    // may exist. It is left for a person, not retried into a second purchase.
    const orderId = await makeOrder();
    let addNewOrderCalls = 0;
    const client = {
      async addNewOrder(): Promise<never> {
        addNewOrderCalls++;
        throw new SmoothParcelUnreadableOrderError(200, { Success: true });
      },
      async getShipmentLabel() {
        return PDF;
      },
    };
    const svc = new ShippingLabelService({ client, labelsDir, enabled: true });

    const first = await svc.requestLabel(orderId, COMPANY_ID);
    expect(first.status).toBe('FAILED');
    expect(first.errorMessage).toMatch(/Smooth Parcel portal/);

    const again = await svc.requestLabel(orderId, COMPANY_ID);
    expect(again.status).toBe('FAILED');
    expect(addNewOrderCalls).toBe(1);
  });
});

describe('ShippingLabelService — creating a new shipment', () => {
  const orderNumberOf = async (orderId: string) =>
    (await getDb().select({ n: customerOrders.orderNumber }).from(customerOrders).where(eq(customerOrders.id, orderId)))[0]!.n;

  it('asks for the label again first, and creates a new shipment with a new reference only when told to', async () => {
    const orderId = await makeOrder();
    const orderNumber = await orderNumberOf(orderId);
    const sent: string[] = [];
    const labelRequests: string[] = [];
    const client = {
      async addNewOrder(payload: { TransactionID: string }) {
        sent.push(payload.TransactionID);
        const code = `55500${sent.length}`;
        return { orderCode: code, trackingNumber: `TRK-${sent.length}`, raw: { OrderCode: Number(code) } };
      },
      async getShipmentLabel(code: string) {
        labelRequests.push(code);
        // The first shipment can never produce a label; a new one can.
        if (code === '555001') throw new Error('No route was matched');
        return PDF;
      },
    };
    const svc = new ShippingLabelService({ client, labelsDir, enabled: true });

    await expect(svc.requestLabel(orderId, COMPANY_ID)).rejects.toThrow('No route was matched');
    const failed = await svc.latestForOrder(orderId, COMPANY_ID);
    expect(failed).toMatchObject({ status: 'FAILED', providerOrderCode: '555001', canCreateNewShipment: true });

    // Try again asks for that shipment's label; it does not send the order again.
    await expect(svc.requestLabel(orderId, COMPANY_ID)).rejects.toThrow('No route was matched');
    expect(sent).toEqual([orderNumber]);
    expect(labelRequests).toEqual(['555001', '555001']);

    const replaced = await svc.requestLabel(orderId, COMPANY_ID, { newShipment: true });
    expect(replaced).toMatchObject({
      status: 'CREATED',
      providerOrderCode: '555002',
      trackingNumber: 'TRK-2',
      shipmentAttempt: 2,
      previousShipmentCodes: ['555001'],
      canCreateNewShipment: false,
      hasLabelFile: true,
    });
    expect(sent).toEqual([orderNumber, `${orderNumber}-2`]);
  });

  it('refuses a new shipment for an order that already has a label', async () => {
    const orderId = await makeOrder();
    const carrier = fakeCarrier();
    const svc = service(carrier.client);
    await svc.requestLabel(orderId, COMPANY_ID);
    await expect(svc.requestLabel(orderId, COMPANY_ID, { newShipment: true })).rejects.toBeInstanceOf(ShippingLabelConflictError);
    expect(carrier.calls.addNewOrder).toBe(1);
  });

  it('lets the user resend a shipment whose reply could not be read, once they choose to', async () => {
    const orderId = await makeOrder();
    let addNewOrderCalls = 0;
    const client = {
      async addNewOrder() {
        addNewOrderCalls++;
        if (addNewOrderCalls === 1) throw new SmoothParcelUnreadableOrderError(200, { Success: true });
        return { orderCode: '555010', trackingNumber: 'TRK-10', raw: {} };
      },
      async getShipmentLabel() {
        return PDF;
      },
    };
    const svc = new ShippingLabelService({ client, labelsDir, enabled: true });

    const held = await svc.requestLabel(orderId, COMPANY_ID);
    expect(held).toMatchObject({ status: 'FAILED', canCreateNewShipment: true });

    const resent = await svc.requestLabel(orderId, COMPANY_ID, { newShipment: true });
    expect(resent).toMatchObject({ status: 'CREATED', providerOrderCode: '555010', shipmentAttempt: 2 });
    expect(addNewOrderCalls).toBe(2);
  });
});
