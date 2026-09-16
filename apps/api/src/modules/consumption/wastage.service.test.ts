/**
 * Standalone wastage (Sept-2026 user testing, item 7).
 *
 * "take this wastage function out of the end of bake form and create a separate
 *  Wastage form … where any items from stock can be marked as wasted."
 *
 * The risks are the ordinary ones for anything that moves stock: a replay that
 * wastes twice, a sign error that ADDS stock through a door marked wastage, and
 * a record nobody can interpret a month later.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  products,
  sites,
  stockLevels,
  stockMovements,
  wastageEvents,
} from '../../db/schema/index.js';
import { WastageService, WastageError } from './wastage.service.js';

const COMPANY = 'f9f9f9f9-f9f9-4f9f-8f9f-f9f9f9f9f9f9';
const svc = new WastageService();

let siteId: string;
let otherSiteId: string;
let eggsId: string;

async function clear(): Promise<void> {
  const db = getDb();
  await db.delete(wastageEvents).where(eq(wastageEvents.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));

  const [eggs] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'W Eggs',
      slug: 'w-eggs',
      itemKind: 'INGREDIENT',
      stockUom: 'each',
      expectedNextCost: '0.25',
    })
    .returning();
  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'w-site', name: 'W Site', canonicalName: 'W Site' })
    .returning();
  const [other] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'w-other', name: 'W Other', canonicalName: 'W Other' })
    .returning();
  eggsId = eggs!.id;
  siteId = site!.id;
  otherSiteId = other!.id;
});

beforeEach(async () => {
  await clear();
  await getDb()
    .insert(stockLevels)
    .values({ companyId: COMPANY, productId: eggsId, siteId, onHand: '600' });
});

afterAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

const base = () => ({
  siteId,
  productId: eggsId,
  qty: 30,
  reason: 'Dropped',
  companyId: COMPANY,
  clientKey: `k-${Math.random()}`,
});

const onHand = async () =>
  Number(
    (
      await getDb().query.stockLevels.findFirst({
        where: and(eq(stockLevels.productId, eggsId), eq(stockLevels.siteId, siteId)),
      })
    )!.onHand,
  );

describe('recording wastage', () => {
  it('takes the stock off the shelf and records why', async () => {
    const event = await svc.record({ ...base(), note: 'Whole tray, tiled floor', recordedBy: 'Sam' });

    expect(Number(event.qty)).toBe(30);
    expect(event.reason).toBe('Dropped');
    expect(event.note).toBe('Whole tray, tiled floor');
    expect(event.recordedBy).toBe('Sam');
    expect(await onHand()).toBe(570);
  });

  it('writes a WASTAGE movement, not an adjustment', async () => {
    // The movement type is what tells wastage from a counting correction in
    // every report and in the Xero posting downstream.
    await svc.record(base());
    const moves = await getDb()
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.companyId, COMPANY), eq(stockMovements.productId, eggsId)));
    expect(moves).toHaveLength(1);
    expect(moves[0]!.movementType).toBe('WASTAGE');
    expect(Number(moves[0]!.qtyDelta)).toBe(-30);
  });

  it('snapshots the cost, so the waste can be valued later', async () => {
    const event = await svc.record(base());
    expect(Number(event.unitCost)).toBe(0.25);
  });

  it('records without a bake, which is the commonest case', async () => {
    // A dropped case of eggs on a Tuesday morning is not part of a bake. That
    // it had nowhere to go is the reason this form exists.
    const event = await svc.record(base());
    expect(event.sessionId).toBeNull();
    expect(event.bake).toBeNull();
  });

  it('keeps the bake link when the waste did happen during one', async () => {
    const event = await svc.record({ ...base(), sessionId: 'BB-999', bake: 'Battenburg' });
    expect(event.sessionId).toBe('BB-999');
    expect(event.bake).toBe('Battenburg');
  });
});

describe('the ways this could corrupt the ledger', () => {
  it('is a no-op on a replay, rather than wasting the stock twice', async () => {
    // An offline queue retries. Without this an intermittent connection would
    // quietly double every wastage entry filed from a venue iPad.
    const input = base();
    const first = await svc.record(input);
    const second = await svc.record(input);

    expect(second.id).toBe(first.id);
    expect(await onHand()).toBe(570);
  });

  it('refuses a negative quantity — that would ADD stock through this door', async () => {
    await expect(svc.record({ ...base(), qty: -30 })).rejects.toThrow(WastageError);
    expect(await onHand()).toBe(600);
  });

  it('refuses zero, which is a form submitted by accident', async () => {
    await expect(svc.record({ ...base(), qty: 0 })).rejects.toThrow(WastageError);
  });

  it('refuses a blank reason', async () => {
    // Wastage with no reason cannot be told from a counting error, and nobody
    // can act on it.
    await expect(svc.record({ ...base(), reason: '   ' })).rejects.toThrow(/reason/i);
  });

  it('refuses an item that is not in the catalogue', async () => {
    await expect(
      svc.record({ ...base(), productId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow(/catalogue/i);
  });

  it('stops a site-bound baker recording against another venue', async () => {
    await expect(
      svc.record({ ...base(), siteId: otherSiteId }, { roles: ['head_baker'], siteId }),
    ).rejects.toThrow('forbidden_site_scope');
  });

  it('lets an admin record for any venue', async () => {
    const event = await svc.record({ ...base(), siteId: otherSiteId }, { roles: ['admin'], siteId });
    expect(event.siteId).toBe(otherSiteId);
  });
});

describe('listing', () => {
  it('returns recent events newest first, with the item name', async () => {
    await svc.record({ ...base(), reason: 'Spillage' });
    await svc.record({ ...base(), reason: 'Burnt' });

    const rows = await svc.list({ siteId }, COMPANY);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.productName).toBe('W Eggs');
    expect(rows.map((r) => r.reason).sort()).toEqual(['Burnt', 'Spillage']);
  });
});
