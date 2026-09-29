/**
 * Booking deliveries in against a purchase order (Sept 2026). Real Postgres,
 * isolated company.
 *
 * Covers: some lines and not others; part of a line, the rest outstanding for
 * a later delivery; an over-delivery refused unless accepted — and then
 * booked; an item not on the order; two lots of one line; the wrong venue, a
 * closed order, a line from another order; undo giving the quantities back;
 * two iPads racing for the last of a line; and the "what is expected" views.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  goodsInReceiptLines,
  goodsInReceipts,
  products,
  purchaseOrderLines,
  purchaseOrders,
  sites,
  stockBatches,
  stockLevels,
  stockMovements,
  suppliers,
} from '../../db/schema/index.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { PurchaseOrderService } from '../purchasing/purchase-order.service.js';
import { GoodsInPurchaseOrderError, GoodsInService, OverDeliveryError } from './goods-in.service.js';
import { openOrdersForSite, receivingView } from './po-receiving.service.js';

const COMPANY = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5';
const svc = new GoodsInService();
const levels = new StockLevelService();
const pos = new PurchaseOrderService();

let east: string;
let south: string;
let supplierId: string;
let flour: string; // bought in 16 kg sacks, stocked in g
let sugar: string; // bought in 1 kg bags
let cream: string; // batch-tracked tubs
let stray: string; // never ordered

let key = 0;
const nextKey = () => `po-rcv-${Date.now()}-${++key}`;

async function wipe(): Promise<void> {
  const db = getDb();
  const receipts = await db.select({ id: goodsInReceipts.id }).from(goodsInReceipts).where(eq(goodsInReceipts.companyId, COMPANY));
  if (receipts.length) {
    await db.delete(goodsInReceiptLines).where(inArray(goodsInReceiptLines.receiptId, receipts.map((r) => r.id)));
  }
  await db.delete(goodsInReceipts).where(eq(goodsInReceipts.companyId, COMPANY));
  const orders = await db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.companyId, COMPANY));
  if (orders.length) {
    await db.delete(purchaseOrderLines).where(inArray(purchaseOrderLines.purchaseOrderId, orders.map((o) => o.id)));
  }
  await db.delete(purchaseOrders).where(eq(purchaseOrders.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(stockBatches).where(eq(stockBatches.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await wipe();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));

  const site = async (slug: string, name: string) =>
    (await db.insert(sites).values({ companyId: COMPANY, slug, name, canonicalName: name }).returning())[0]!.id;
  east = await site('por-east', 'POR East');
  south = await site('por-south', 'POR South');
  supplierId = (await db.insert(suppliers).values({ companyId: COMPANY, name: 'POR Brakes' }).returning())[0]!.id;
  const product = async (slug: string, over: Partial<typeof products.$inferInsert>) =>
    (
      await db
        .insert(products)
        .values({ companyId: COMPANY, name: `POR ${slug}`, slug: `por-${slug}`, itemKind: 'INGREDIENT', ...over })
        .returning()
    )[0]!.id;
  flour = await product('flour', { stockUom: 'g', purchaseUom: 'sack', purchaseToStockFactor: '16000' });
  sugar = await product('sugar', { stockUom: 'g', purchaseUom: 'bag', purchaseToStockFactor: '1000' });
  cream = await product('cream', { stockUom: 'ml', purchaseUom: 'tub', purchaseToStockFactor: '1000', requireBatchNumber: true });
  stray = await product('stray', { stockUom: 'each', purchaseUom: 'each', purchaseToStockFactor: '1' });
});

beforeEach(wipe);

afterAll(async () => {
  const db = getDb();
  await wipe();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

/** An order for East: 10 sacks of flour at £18 and 5 bags of sugar at £1.20. */
async function order(over: { siteId?: string | null; lines?: Array<{ productId: string; quantity: number }> } = {}) {
  const po = await pos.create(COMPANY, {
    supplierId,
    siteId: over.siteId === null ? undefined : (over.siteId ?? east),
    currencyCode: 'GBP',
    deliveryCharge: 0,
    vatTreatment: 'STANDARD_VAT_20',
    exchangeRate: 1,
    lines: (over.lines ?? [
      { productId: flour, quantity: 10 },
      { productId: sugar, quantity: 5 },
    ]).map((l) => ({ ...l, pricePerUnit: l.productId === flour ? 18 : 1.2, taxRate: 0 })),
  });
  const lines = await getDb().select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po!.id));
  const lineFor = (productId: string) => lines.find((l) => l.productId === productId)!.id;
  return { id: po!.id, poNumber: po!.poNumber, lineFor };
}

const book = (
  po: { id: string; lineFor: (p: string) => string },
  lines: Array<{ productId: string; qty: number; onOrder?: boolean; batchCode?: string }>,
  extra: { acceptOverDelivery?: boolean; siteId?: string; idempotencyKey?: string } = {},
) =>
  svc.receive({
    siteId: extra.siteId ?? east,
    purchaseOrderId: po.id,
    deliveryNoteNumber: 'DN-1',
    idempotencyKey: extra.idempotencyKey ?? nextKey(),
    acceptOverDelivery: extra.acceptOverDelivery,
    companyId: COMPANY,
    lines: lines.map((l) => ({
      productId: l.productId,
      qtyPurchase: l.qty,
      unitCost: 1,
      batchCode: l.batchCode,
      purchaseOrderLineId: l.onOrder === false ? null : po.lineFor(l.productId),
    })),
  });

const state = async (poId: string) => {
  const view = (await receivingView(poId, COMPANY))!;
  return {
    status: view.deliveryStatus,
    lines: Object.fromEntries(
      view.lines.map((l) => [l.product.slug, { received: l.received, outstanding: l.outstanding, status: l.deliveryStatus }]),
    ),
  };
};
const onHand = async (productId: string, siteId = east) => Number(await levels.getOnHand(productId, siteId, COMPANY));

describe('booking part of an order', () => {
  it('some lines and not others: the rest stays outstanding', async () => {
    const po = await order();
    const r = await book(po, [{ productId: flour, qty: 10 }]);

    expect(await state(po.id)).toEqual({
      status: 'PARTIALLY_RECEIVED',
      lines: {
        'por-flour': { received: 10, outstanding: 0, status: 'FULLY_RECEIVED' },
        'por-sugar': { received: 0, outstanding: 5, status: 'PENDING' },
      },
    });
    // Short on the order as a whole, though the one line booked was complete.
    expect(r.receipt).toMatchObject({ variance: 'UNDER', purchaseOrderId: po.id, deliveryNoteNumber: 'DN-1', supplierId });
    expect(r.lines[0]).toMatchObject({ lineVariance: 'NONE', expectedQtyPurchase: '10.000' });
    expect(await onHand(flour)).toBe(160_000);
    expect(await onHand(sugar)).toBe(0);
  });

  it('part of a line now, the rest later, until the order is complete', async () => {
    const po = await order();
    const first = await book(po, [{ productId: flour, qty: 4 }, { productId: sugar, qty: 5 }]);
    expect(first.lines.find((l) => l.productId === flour)).toMatchObject({ lineVariance: 'UNDER', expectedQtyPurchase: '10.000' });
    expect((await state(po.id)).lines['por-flour']).toEqual({ received: 4, outstanding: 6, status: 'PARTIALLY_RECEIVED' });

    // The second delivery is measured against what was STILL to come.
    const second = await book(po, [{ productId: flour, qty: 6 }]);
    expect(second.lines[0]).toMatchObject({ lineVariance: 'NONE', expectedQtyPurchase: '6.000' });
    expect(second.receipt.variance).toBe('NONE');
    expect((await state(po.id)).status).toBe('FULLY_RECEIVED');
    expect(await onHand(flour)).toBe(160_000);
  });

  it('two lots of one line both count towards it', async () => {
    const po = await order({ lines: [{ productId: cream, quantity: 6 }] });
    await book(po, [
      { productId: cream, qty: 3, batchCode: 'LOT-A' },
      { productId: cream, qty: 2, batchCode: 'LOT-B' },
    ]);
    expect((await state(po.id)).lines['por-cream']).toEqual({ received: 5, outstanding: 1, status: 'PARTIALLY_RECEIVED' });
    expect(await onHand(cream)).toBe(5000);
  });
});

describe('over-deliveries', () => {
  it('more than is outstanding is refused, with the details, and nothing is written', async () => {
    const po = await order();
    const err = await book(po, [{ productId: flour, qty: 12 }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OverDeliveryError);
    expect((err as OverDeliveryError).lines).toEqual([
      expect.objectContaining({ productName: 'POR flour', ordered: 10, alreadyReceived: 0, receivingNow: 12, over: 2 }),
    ]);
    expect((err as Error).message).toMatch(/ordered 10, already received 0, booking 12/);

    expect((await state(po.id)).lines['por-flour'].received).toBe(0);
    expect(await onHand(flour)).toBe(0);
    const receipts = await getDb().select().from(goodsInReceipts).where(eq(goodsInReceipts.purchaseOrderId, po.id));
    expect(receipts).toHaveLength(0);
  });

  it('accepted, it is booked in full and flagged OVER', async () => {
    const po = await order();
    const r = await book(po, [{ productId: flour, qty: 12 }, { productId: sugar, qty: 5 }], { acceptOverDelivery: true });
    expect(r.receipt.variance).toBe('OVER');
    expect(r.lines.find((l) => l.productId === flour)).toMatchObject({ lineVariance: 'OVER', qtyPurchase: '12.000' });
    expect(await state(po.id)).toEqual({
      status: 'FULLY_RECEIVED',
      lines: {
        'por-flour': { received: 12, outstanding: 0, status: 'FULLY_RECEIVED' },
        'por-sugar': { received: 5, outstanding: 0, status: 'FULLY_RECEIVED' },
      },
    });
    expect(await onHand(flour)).toBe(192_000);
  });

  it('a late extra on a line already complete is an over-delivery too', async () => {
    const po = await order({ lines: [{ productId: sugar, quantity: 5 }] });
    await book(po, [{ productId: sugar, qty: 5 }]);
    await expect(book(po, [{ productId: sugar, qty: 1 }])).rejects.toBeInstanceOf(OverDeliveryError);
    await book(po, [{ productId: sugar, qty: 1 }], { acceptOverDelivery: true });
    expect((await state(po.id)).lines['por-sugar']).toEqual({ received: 6, outstanding: 0, status: 'FULLY_RECEIVED' });
  });

  it('an item not on the order needs the same acceptance, and leaves the order alone', async () => {
    const po = await order();
    const err = await book(po, [{ productId: stray, qty: 3, onOrder: false }]).catch((e: unknown) => e);
    expect((err as OverDeliveryError).lines).toEqual([expect.objectContaining({ ordered: 0, receivingNow: 3, purchaseOrderLineId: null })]);
    expect((err as Error).message).toMatch(/POR stray is not on the order/);

    const r = await book(po, [{ productId: stray, qty: 3, onOrder: false }], { acceptOverDelivery: true });
    expect(r.lines[0]).toMatchObject({ purchaseOrderLineId: null, lineVariance: 'OVER' });
    expect((await state(po.id)).status).toBe('PENDING');
    expect(await onHand(stray)).toBe(3);
  });
});

describe('what cannot be booked against an order', () => {
  it('the wrong venue', async () => {
    const po = await order();
    const err = await book(po, [{ productId: flour, qty: 1 }], { siteId: south }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoodsInPurchaseOrderError);
    expect((err as GoodsInPurchaseOrderError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/is for POR East/);
  });

  it('an order with no venue can be booked into any venue', async () => {
    const po = await order({ siteId: null });
    await book(po, [{ productId: flour, qty: 1 }], { siteId: south });
    expect(await onHand(flour, south)).toBe(16_000);
  });

  it('a closed order', async () => {
    const po = await order();
    await pos.close(po.id, COMPANY);
    const err = await book(po, [{ productId: flour, qty: 1 }]).catch((e: unknown) => e);
    expect((err as GoodsInPurchaseOrderError).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/has been closed/);
  });

  it("a line from another order, or a line booked as the wrong product", async () => {
    const po = await order();
    const other = await order();
    await expect(
      svc.receive({
        siteId: east,
        purchaseOrderId: po.id,
        idempotencyKey: nextKey(),
        companyId: COMPANY,
        lines: [{ productId: flour, qtyPurchase: 1, purchaseOrderLineId: other.lineFor(flour) }],
      }),
    ).rejects.toThrow(/is not on PO-/);
    await expect(
      svc.receive({
        siteId: east,
        purchaseOrderId: po.id,
        idempotencyKey: nextKey(),
        companyId: COMPANY,
        lines: [{ productId: sugar, qtyPurchase: 1, purchaseOrderLineId: po.lineFor(flour) }],
      }),
    ).rejects.toThrow(/different product/);
  });
});

describe('undo and concurrency', () => {
  it('undoing a receipt makes its quantities outstanding again', async () => {
    const po = await order();
    const r = await book(po, [{ productId: flour, qty: 10 }, { productId: sugar, qty: 5 }]);
    expect((await state(po.id)).status).toBe('FULLY_RECEIVED');

    const rev = await svc.reverse({ receiptId: r.receipt.id, companyId: COMPANY });
    expect(rev!.reversal.purchaseOrderId).toBe(po.id);
    expect(await state(po.id)).toEqual({
      status: 'PENDING',
      lines: {
        'por-flour': { received: 0, outstanding: 10, status: 'PENDING' },
        'por-sugar': { received: 0, outstanding: 5, status: 'PENDING' },
      },
    });
    expect(await onHand(flour)).toBe(0);
  });

  it('two iPads booking the last of a line: one books it, the other is told', async () => {
    const po = await order({ lines: [{ productId: flour, quantity: 10 }] });
    const results = await Promise.allSettled([book(po, [{ productId: flour, qty: 6 }]), book(po, [{ productId: flour, qty: 6 }])]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(OverDeliveryError);
    expect((refused.reason as OverDeliveryError).lines[0]).toMatchObject({ alreadyReceived: 6, receivingNow: 6 });
    expect((await state(po.id)).lines['por-flour'].received).toBe(6);
  });

  it('a replay of a booking that completed the line returns it, not an over-delivery', async () => {
    const po = await order({ lines: [{ productId: sugar, quantity: 5 }] });
    const k = nextKey();
    const first = await book(po, [{ productId: sugar, qty: 5 }], { idempotencyKey: k });
    const again = await book(po, [{ productId: sugar, qty: 5 }], { idempotencyKey: k });
    expect(again.alreadyExisted).toBe(true);
    expect(again.receipt.id).toBe(first.receipt.id);
    expect((await state(po.id)).lines['por-sugar'].received).toBe(5);
  });
});

describe('what is expected', () => {
  it("a venue's open orders, with how many lines are still to come", async () => {
    const po = await order();
    await order({ siteId: south });
    await book(po, [{ productId: flour, qty: 10 }]);
    const done = await order({ lines: [{ productId: sugar, quantity: 1 }] });
    await book(done, [{ productId: sugar, qty: 1 }]);

    const expected = await openOrdersForSite(east, COMPANY);
    expect(expected.map((o) => [o.id, o.lines, o.linesOutstanding, o.supplierName])).toEqual([[po.id, 2, 1, 'POR Brakes']]);
  });

  it('an order laid out for booking, with its receipts', async () => {
    const po = await order();
    await book(po, [{ productId: flour, qty: 4 }]);
    const view = (await receivingView(po.id, COMPANY))!;
    expect(view).toMatchObject({ poNumber: po.poNumber, site: { id: east, name: 'POR East' }, supplier: { name: 'POR Brakes' } });
    expect(view.lines.map((l) => [l.product.purchaseUom, l.ordered, l.received, l.outstanding])).toEqual([
      ['sack', 10, 4, 6],
      ['bag', 5, 0, 5],
    ]);
    expect(view.receipts).toEqual([expect.objectContaining({ deliveryNoteNumber: 'DN-1', lines: 1, variance: 'UNDER' })]);
  });
});
