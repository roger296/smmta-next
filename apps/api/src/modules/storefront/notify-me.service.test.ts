/**
 * Integration tests for NotifyMeService.
 *
 * Hits a real Postgres at DATABASE_URL — same pattern as the other
 * storefront integration tests. Inserts a throwaway product +
 * stock_items under a fixture company; exercises record() + the
 * fulfilForProduct() trigger via an in-memory sender.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  newsletterSubscribers,
  productGroups,
  products,
  stockItems,
  stockNotifications,
  warehouses,
} from '../../db/schema/index.js';
import { NotifyMeService } from './notify-me.service.js';
import { InMemoryNotifyMeSender } from './notify-me.sender.js';

const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const service = new NotifyMeService();

let warehouseId: string;
let groupId: string;
let productId: string;
let secondProductId: string;

async function wipe() {
  const db = getDb();
  // Clean in dependency order.
  const productRows = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.companyId, COMPANY));
  const ids = productRows.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(stockNotifications).where(inArray(stockNotifications.productId, ids));
    await db.delete(stockItems).where(inArray(stockItems.productId, ids));
    await db.delete(products).where(inArray(products.id, ids));
  }
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY));
  await db.delete(warehouses).where(eq(warehouses.companyId, COMPANY));
  await db.delete(newsletterSubscribers).where(eq(newsletterSubscribers.companyId, COMPANY));
}

beforeAll(async () => {
  await wipe();
  const db = getDb();
  const [w] = await db
    .insert(warehouses)
    .values({ companyId: COMPANY, name: 'NotifyMe WH', isDefault: true })
    .returning();
  warehouseId = w!.id;

  const [g] = await db
    .insert(productGroups)
    .values({ companyId: COMPANY, name: 'Notify Group', slug: 'notify-group' })
    .returning();
  groupId = g!.id;

  const [p1] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'Notify Variant Smoke',
      slug: 'notify-variant-smoke',
      groupId,
      colour: 'Smoke',
      minSellingPrice: '10.00',
      heroImageUrl: 'https://example.com/smoke.png',
    })
    .returning();
  productId = p1!.id;

  const [p2] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'Notify Variant Amber',
      slug: 'notify-variant-amber',
      groupId,
      colour: 'Amber',
      minSellingPrice: '10.00',
    })
    .returning();
  secondProductId = p2!.id;
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

beforeEach(async () => {
  const db = getDb();
  await db
    .delete(stockNotifications)
    .where(inArray(stockNotifications.productId, [productId, secondProductId]));
  await db
    .delete(stockItems)
    .where(inArray(stockItems.productId, [productId, secondProductId]));
  await db.delete(newsletterSubscribers).where(eq(newsletterSubscribers.companyId, COMPANY));
});

describe('record()', () => {
  it('inserts a pending row and (when ticked) a newsletter subscriber', async () => {
    const r = await service.record(COMPANY, {
      productId,
      email: 'Pat@Example.invalid',
      subscribeToNewsletter: true,
    });
    expect(r).toEqual({ ok: true, created: true });

    const db = getDb();
    const sn = await db.query.stockNotifications.findMany({
      where: and(
        eq(stockNotifications.productId, productId),
        isNull(stockNotifications.deletedAt),
      ),
    });
    expect(sn).toHaveLength(1);
    expect(sn[0]!.email).toBe('pat@example.invalid'); // normalised
    expect(sn[0]!.subscribedToNewsletter).toBe(true);
    expect(sn[0]!.fulfilledAt).toBeNull();

    const news = await db.query.newsletterSubscribers.findMany({
      where: eq(newsletterSubscribers.companyId, COMPANY),
    });
    expect(news).toHaveLength(1);
    expect(news[0]!.email).toBe('pat@example.invalid');
    expect(news[0]!.source).toBe('stock_notification');
    expect(news[0]!.unsubscribeToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent on (productId, email) for pending rows', async () => {
    await service.record(COMPANY, {
      productId,
      email: 'pat@example.invalid',
      subscribeToNewsletter: true,
    });
    const second = await service.record(COMPANY, {
      productId,
      email: 'pat@example.invalid',
      subscribeToNewsletter: true,
    });
    expect(second.created).toBe(false);

    const db = getDb();
    const rows = await db.query.stockNotifications.findMany({
      where: eq(stockNotifications.productId, productId),
    });
    expect(rows).toHaveLength(1);
  });

  it('toggles the newsletter flag on re-submit without inserting a duplicate', async () => {
    await service.record(COMPANY, {
      productId,
      email: 'pat@example.invalid',
      subscribeToNewsletter: true,
    });
    await service.record(COMPANY, {
      productId,
      email: 'pat@example.invalid',
      subscribeToNewsletter: false,
    });
    const db = getDb();
    const rows = await db.query.stockNotifications.findMany({
      where: eq(stockNotifications.productId, productId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscribedToNewsletter).toBe(false);
  });

  it('does not insert a newsletter row when the box is unticked', async () => {
    await service.record(COMPANY, {
      productId,
      email: 'pat@example.invalid',
      subscribeToNewsletter: false,
    });
    const db = getDb();
    const news = await db.query.newsletterSubscribers.findMany({
      where: eq(newsletterSubscribers.companyId, COMPANY),
    });
    expect(news).toHaveLength(0);
  });
});

describe('getFreeStock()', () => {
  it('returns 0 when no stock_items exist', async () => {
    expect(await service.getFreeStock(COMPANY, productId)).toBe(0);
  });

  it('counts only IN_STOCK rows, ignoring RESERVED / ALLOCATED', async () => {
    const db = getDb();
    await db.insert(stockItems).values([
      { companyId: COMPANY, productId, warehouseId, status: 'IN_STOCK', quantity: 1 },
      { companyId: COMPANY, productId, warehouseId, status: 'IN_STOCK', quantity: 1 },
      { companyId: COMPANY, productId, warehouseId, status: 'RESERVED', quantity: 1 },
      { companyId: COMPANY, productId, warehouseId, status: 'ALLOCATED', quantity: 1 },
      { companyId: COMPANY, productId, warehouseId, status: 'SOLD', quantity: 1 },
    ]);
    expect(await service.getFreeStock(COMPANY, productId)).toBe(2);
  });
});

describe('fulfilForProduct()', () => {
  it('does nothing when free stock is zero', async () => {
    await service.record(COMPANY, {
      productId,
      email: 'pat@example.invalid',
      subscribeToNewsletter: false,
    });
    const sender = new InMemoryNotifyMeSender();
    const sent = await service.fulfilForProduct(COMPANY, productId, sender);
    expect(sent).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  it('does nothing when there are no pending notifications', async () => {
    const db = getDb();
    await db.insert(stockItems).values({
      companyId: COMPANY,
      productId,
      warehouseId,
      status: 'IN_STOCK',
      quantity: 1,
    });
    const sender = new InMemoryNotifyMeSender();
    const sent = await service.fulfilForProduct(COMPANY, productId, sender);
    expect(sent).toBe(0);
  });

  it('fulfils up to free-stock count, FIFO order', async () => {
    const db = getDb();
    await service.record(COMPANY, {
      productId,
      email: 'a@example.invalid',
      subscribeToNewsletter: false,
    });
    // Force a small gap in requestedAt so the FIFO ordering is deterministic.
    await new Promise((r) => setTimeout(r, 5));
    await service.record(COMPANY, {
      productId,
      email: 'b@example.invalid',
      subscribeToNewsletter: false,
    });
    await new Promise((r) => setTimeout(r, 5));
    await service.record(COMPANY, {
      productId,
      email: 'c@example.invalid',
      subscribeToNewsletter: false,
    });
    // Only 2 free units → only first 2 customers get notified.
    await db.insert(stockItems).values([
      { companyId: COMPANY, productId, warehouseId, status: 'IN_STOCK', quantity: 1 },
      { companyId: COMPANY, productId, warehouseId, status: 'IN_STOCK', quantity: 1 },
    ]);

    const sender = new InMemoryNotifyMeSender();
    const sent = await service.fulfilForProduct(COMPANY, productId, sender);
    expect(sent).toBe(2);
    expect(sender.sent.map((s) => s.email)).toEqual([
      'a@example.invalid',
      'b@example.invalid',
    ]);

    const rows = await db.query.stockNotifications.findMany({
      where: eq(stockNotifications.productId, productId),
      orderBy: stockNotifications.requestedAt,
    });
    expect(rows.find((r) => r.email === 'a@example.invalid')!.fulfilledAt).not.toBeNull();
    expect(rows.find((r) => r.email === 'b@example.invalid')!.fulfilledAt).not.toBeNull();
    expect(rows.find((r) => r.email === 'c@example.invalid')!.fulfilledAt).toBeNull();
  });

  it('leaves rows pending when the sender throws (retried on the next trigger)', async () => {
    const db = getDb();
    await service.record(COMPANY, {
      productId,
      email: 'flaky@example.invalid',
      subscribeToNewsletter: false,
    });
    await db.insert(stockItems).values({
      companyId: COMPANY,
      productId,
      warehouseId,
      status: 'IN_STOCK',
      quantity: 1,
    });

    const sender = new InMemoryNotifyMeSender();
    sender.failNext = true;
    const sent = await service.fulfilForProduct(COMPANY, productId, sender);
    expect(sent).toBe(0);

    const rows = await db.query.stockNotifications.findMany({
      where: eq(stockNotifications.productId, productId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fulfilledAt).toBeNull();
  });

  it('lets the same email re-enrol after a previous fulfilment', async () => {
    const db = getDb();
    await service.record(COMPANY, {
      productId,
      email: 'returning@example.invalid',
      subscribeToNewsletter: false,
    });
    await db.insert(stockItems).values({
      companyId: COMPANY,
      productId,
      warehouseId,
      status: 'IN_STOCK',
      quantity: 1,
    });
    const sender = new InMemoryNotifyMeSender();
    expect(await service.fulfilForProduct(COMPANY, productId, sender)).toBe(1);

    // Stock goes out, customer re-enrols.
    await db.delete(stockItems).where(eq(stockItems.productId, productId));
    const r = await service.record(COMPANY, {
      productId,
      email: 'returning@example.invalid',
      subscribeToNewsletter: false,
    });
    expect(r.created).toBe(true);

    const rows = await db.query.stockNotifications.findMany({
      where: eq(stockNotifications.productId, productId),
    });
    expect(rows).toHaveLength(2);
    const fulfilled = rows.filter((r) => r.fulfilledAt !== null);
    const pending = rows.filter((r) => r.fulfilledAt === null);
    expect(fulfilled).toHaveLength(1);
    expect(pending).toHaveLength(1);
  });
});
