/**
 * The 12 August 2026 defect register, server side (F15).
 *
 * One named test per defect ID that has an API surface, each title quoting the
 * tester. Defects whose whole surface is the browser are covered by
 * `apps/web/e2e/feedback-2026-08-12.spec.ts` and named there.
 *
 * The point of this file is not coverage — every one of these already has a
 * dedicated suite. It is a *register*: a single place where somebody can read
 * down the list on 11 August next year and see that each reported symptom
 * still has a test with its name on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { closeDatabase, getDb } from '../config/database.js';
import {
  devicePins,
  goodsInReceiptLines,
  goodsInReceipts,
  products,
  recipeLines,
  recipes,
  sessionConsumption,
  sessionConsumptionLines,
  sites,
  stockLevels,
  stockMovements,
  stockTakeLines,
  stockTakes,
} from '../db/schema/index.js';
import { getSingletonCompanyId } from '../shared/auth/company.js';
import { hashPassword } from '../shared/auth/password.js';
import { MAX_PAGE_SIZE } from '../shared/utils/pagination.js';
import { RecipeService } from './recipes/recipe.service.js';
import { ExpectedConsumptionService } from './recipes/expected-consumption.service.js';

const COMPANY = getSingletonCompanyId();
const SLUG = 'fb-aug12';

let app: FastifyInstance;
let adminToken: string;
let bakerToken: string;
let siteId: string;
let icingId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function cleanup(): Promise<void> {
  const db = getDb();
  const mine = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.companyId, COMPANY), inArray(products.slug, [`${SLUG}-icing`])));
  if (mine.length > 0) {
    const ids = mine.map((p) => p.id);
    await db.delete(stockTakeLines).where(inArray(stockTakeLines.productId, ids));
    await db.delete(goodsInReceiptLines).where(inArray(goodsInReceiptLines.productId, ids));
    await db
      .delete(sessionConsumptionLines)
      .where(inArray(sessionConsumptionLines.productId, ids));
    await db.delete(stockMovements).where(inArray(stockMovements.productId, ids));
    await db.delete(stockLevels).where(inArray(stockLevels.productId, ids));
    await db.delete(recipeLines).where(inArray(recipeLines.productId, ids));
    await db.delete(products).where(inArray(products.id, ids));
  }
  const mySites = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.companyId, COMPANY), eq(sites.slug, `${SLUG}-south`)));
  if (mySites.length > 0) {
    const ids = mySites.map((s) => s.id);
    // Everything that references the site, innermost first. A site row cannot
    // go while a stock-take, a receipt or a bake still points at it.
    const takes = await db
      .select({ id: stockTakes.id })
      .from(stockTakes)
      .where(inArray(stockTakes.siteId, ids));
    if (takes.length > 0) {
      await db
        .delete(stockTakeLines)
        .where(inArray(stockTakeLines.stockTakeId, takes.map((t) => t.id)));
      await db.delete(stockTakes).where(inArray(stockTakes.id, takes.map((t) => t.id)));
    }
    const receipts = await db
      .select({ id: goodsInReceipts.id })
      .from(goodsInReceipts)
      .where(inArray(goodsInReceipts.siteId, ids));
    if (receipts.length > 0) {
      await db
        .delete(goodsInReceiptLines)
        .where(inArray(goodsInReceiptLines.receiptId, receipts.map((r) => r.id)));
      await db.delete(goodsInReceipts).where(inArray(goodsInReceipts.id, receipts.map((r) => r.id)));
    }
    const records = await db
      .select({ id: sessionConsumption.id })
      .from(sessionConsumption)
      .where(inArray(sessionConsumption.siteId, ids));
    if (records.length > 0) {
      await db
        .delete(sessionConsumptionLines)
        .where(inArray(sessionConsumptionLines.consumptionId, records.map((r) => r.id)));
      await db.delete(sessionConsumption).where(inArray(sessionConsumption.id, records.map((r) => r.id)));
    }
    await db.delete(stockMovements).where(inArray(stockMovements.siteId, ids));
    await db.delete(stockLevels).where(inArray(stockLevels.siteId, ids));
    await db.delete(devicePins).where(inArray(devicePins.siteId, ids));
    await db.delete(sites).where(inArray(sites.id, ids));
  }
  const myRecipes = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(and(eq(recipes.companyId, COMPANY), eq(recipes.bake, 'FB Aug12 Cake')));
  if (myRecipes.length > 0) {
    await db.delete(recipeLines).where(inArray(recipeLines.recipeId, myRecipes.map((r) => r.id)));
    await db.delete(recipes).where(inArray(recipes.id, myRecipes.map((r) => r.id)));
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  await cleanup();

  const db = getDb();
  const [site] = await db
    .insert(sites)
    .values({
      companyId: COMPANY,
      slug: `${SLUG}-south`,
      name: 'FB London South',
      canonicalName: 'FB London South',
      isActive: true,
    })
    .returning();
  siteId = site!.id;

  adminToken = app.jwt.sign({
    userId: 'fb-admin', companyId: COMPANY, email: 'fb@test.invalid', roles: ['admin'],
  });
  bakerToken = app.jwt.sign({
    userId: 'fb-baker', companyId: COMPANY, email: 'fb2@test.invalid',
    roles: ['head_baker'], siteId,
  });

  // The 12 Aug delivery, as it should have been set up: a 25 kg sack of icing
  // sugar, priced per gram, with a barcode.
  const [icing] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'FB Icing sugar',
      slug: `${SLUG}-icing`,
      stockCode: 'FB-ICING',
      barcode: '5099999999999',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
      purchaseUom: 'sack',
      purchaseToStockFactor: '25000',
      packDescription: '25 kg sack',
      expectedNextCost: '0.001200',
      isStocked: true,
      isSold: false,
    })
    .returning();
  icingId = icing!.id;
});

afterAll(async () => {
  await cleanup();
  await app?.close();
  await closeDatabase();
});

describe('C — products, units and cost', () => {
  it('C-1: "Icing sugar displayed an incorrect default unit quantity of 1kg"', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/products/${icingId}`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const p = res.json().data;
    // The purchase side exists and is served — without it the screen has no
    // way to say "1 × 25 kg sack" and falls back to one stock unit.
    expect(p.purchaseUom).toBe('sack');
    expect(Number(p.purchaseToStockFactor)).toBe(25000);
    expect(p.packDescription).toBe('25 kg sack');
  });

  it('C-2: "Skittles displayed an incorrect base unit, preventing the 1.6kg bags from being added"', async () => {
    // Same model, a different pack: 1.6 kg bags. The defect was that the model
    // did not exist, so any pack size at all is the regression test.
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${icingId}`,
      headers: auth(adminToken),
      payload: { purchaseUom: 'bag', purchaseToStockFactor: 1600, packDescription: '1.6 kg bag' },
    });
    expect(res.statusCode).toBe(200);
    expect(Number(res.json().data.purchaseToStockFactor)).toBe(1600);

    // Put it back for the rest of the file.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${icingId}`,
      headers: auth(adminToken),
      payload: { purchaseUom: 'sack', purchaseToStockFactor: 25000, packDescription: '25 kg sack' },
    });
  });

  it('C-3: "Manual barcode entry failed to find the product for an icing sugar delivery"', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/products/by-code/5099999999999',
      headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(icingId);
  });

  it('C-4: costs displayed as £0.00', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/products/${icingId}`, headers: auth(adminToken),
    });
    // numeric(18,6): £0.0012 a gram survives the round trip. At the old
    // decimal(18,2) it stored as 0.00 and every cost on screen was zero.
    expect(Number(res.json().data.expectedNextCost)).toBeCloseTo(0.0012, 6);
  });

  it('C-5: could not set a price from the venue screen', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${icingId}`,
      headers: auth(adminToken),
      payload: { expectedNextCost: 0.0013 },
    });
    expect(res.statusCode).toBe(200);
    expect(Number(res.json().data.expectedNextCost)).toBeCloseTo(0.0013, 6);
    await app.inject({
      method: 'PUT',
      url: `/api/v1/products/${icingId}`,
      headers: auth(adminToken),
      payload: { expectedNextCost: 0.0012 },
    });
  });
});

describe('D — counting and number entry', () => {
  it('D-1: "Every row read as a raw alphanumeric string, so no count could be logged"', async () => {
    // The root cause: pageSize=500 over the cap does not truncate, it 400s.
    const over = await app.inject({
      method: 'GET',
      url: `/api/v1/products?pageSize=${MAX_PAGE_SIZE + 1}`,
      headers: auth(adminToken),
    });
    expect(over.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'GET',
      url: `/api/v1/products?pageSize=${MAX_PAGE_SIZE}`,
      headers: auth(adminToken),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('D-1b: the count sheet does not need a second request to know what it is asking for', async () => {
    // A count sheet lists what the site holds, so put something on the shelf.
    const booked = await app.inject({
      method: 'POST',
      url: '/api/v1/goods-in',
      headers: auth(adminToken),
      payload: {
        siteId,
        idempotencyKey: `fb-aug12-d1b-${siteId}`,
        lines: [{ productId: icingId, qtyPurchase: 1, unitCost: 30 }],
      },
    });
    expect(booked.statusCode, booked.body).toBe(201);

    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-takes',
      headers: auth(bakerToken),
      payload: { siteId, scope: 'FULL' },
    });
    expect(opened.statusCode).toBe(201);
    const lines = opened.json().data.lines as Array<Record<string, unknown>>;
    const mine = lines.find((l) => l.productId === icingId);
    expect(mine, 'the new count sheet should carry the stocked product').toBeTruthy();
    // Identity comes down WITH the sheet — name, code and unit — so a failed
    // side lookup can never reduce a row to eight hex characters again.
    expect(mine!.productName).toBe('FB Icing sugar');
    expect(mine!.stockCode).toBe('FB-ICING');
    expect(mine!.stockUom).toBe('g');
  });

  it('D-2: counts silently rounded to the nearest 100 stock units (4 kg → 0)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/products/${icingId}`, headers: auth(adminToken),
    });
    // NULL, not 0 and not 100. "No rounding" is spelled blank; the blanket
    // default is what turned a 4 kg count into nothing.
    expect(res.json().data.countQuantum).toBeNull();
  });
});

describe('E — site binding, entry and permissions', () => {
  it('E-1: "Accidental booking logged 100kg to Birmingham" from a South London device', async () => {
    const db = getDb();
    await db.insert(devicePins).values({
      companyId: COMPANY,
      label: 'FB South iPad',
      pinHash: await hashPassword('4321'),
      roles: ['head_baker'],
      siteId,
      isActive: true,
    });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/pin-login', payload: { pin: '4321' },
    });
    expect(res.statusCode).toBe(200);
    const user = res.json().data.user;
    // The binding travels with the login — id AND name. The id alone is not
    // something a venue screen can put in front of a baker.
    expect(user.siteId).toBe(siteId);
    expect(user.siteName).toBe('FB London South');
  });

  it('E-4: "…or role-based permission locks"', async () => {
    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/stock-takes',
      headers: auth(bakerToken),
      payload: { siteId, scope: 'FULL' },
    });
    expect(opened.statusCode).toBe(201);
    const id = opened.json().data.take.id;

    // A head baker records; a site manager approves. Enforced server-side, not
    // merely hidden in the UI.
    const refused = await app.inject({
      method: 'POST', url: `/api/v1/stock-takes/${id}/approve`, headers: auth(bakerToken),
    });
    expect(refused.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST', url: `/api/v1/stock-takes/${id}/approve`, headers: auth(adminToken),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('E-3: "Requested an undo timer"', async () => {
    const db0 = getDb();
    const before = await db0
      .select({ qty: stockMovements.qtyDelta })
      .from(stockMovements)
      .where(eq(stockMovements.productId, icingId));
    const netBefore = before.reduce((sum, m) => sum + Number(m.qty), 0);

    const booked = await app.inject({
      method: 'POST',
      url: '/api/v1/goods-in',
      headers: auth(adminToken),
      payload: {
        siteId,
        idempotencyKey: `fb-aug12-${siteId}`,
        // One 25 kg sack, in PURCHASE units — the pack model C-1/C-2 added.
        lines: [{ productId: icingId, qtyPurchase: 1, unitCost: 30 }],
      },
    });
    expect(booked.statusCode).toBe(201);
    const receiptId = booked.json().data.receipt.id;

    // A head baker cannot reverse — that is the "permission lock" half of E-4.
    const refused = await app.inject({
      method: 'POST', url: `/api/v1/goods-in/${receiptId}/reverse`, headers: auth(bakerToken),
    });
    expect(refused.statusCode).toBe(403);

    const reversed = await app.inject({
      method: 'POST',
      url: `/api/v1/goods-in/${receiptId}/reverse`,
      headers: auth(adminToken),
      payload: { reason: 'Booked to the wrong venue' },
    });
    expect([200, 201]).toContain(reversed.statusCode);

    // Reversal is a NEW, opposite movement — history is never mutated. The
    // ledger keeps both rows and they cancel; nothing is deleted or edited.
    const db = getDb();
    const after = await db
      .select({ qty: stockMovements.qtyDelta })
      .from(stockMovements)
      .where(eq(stockMovements.productId, icingId));
    // Two new rows — the booking and its opposite — and a net of nothing.
    expect(after.length).toBe(before.length + 2);
    expect(after.reduce((sum, m) => sum + Number(m.qty), 0)).toBe(netBefore);
  });
});

describe('F — end of bake and recipe data', () => {
  const recipeSvc = new RecipeService();
  const expected = new ExpectedConsumptionService();
  const BAKE = 'FB Aug12 Cake';

  it('F-5: "Selecting Vegan or GF options for Battenburg failed to generate required ingredients"', async () => {
    const db = getDb();
    const [gfFlour] = await db
      .insert(products)
      .values({
        companyId: COMPANY, name: 'FB GF flour', slug: `${SLUG}-gf`,
        stockCode: 'FB-GF', itemKind: 'INGREDIENT', stockUom: 'g',
      })
      .returning();

    try {
      await recipeSvc.create({
        bake: BAKE,
        siteId: null,
        effectiveFrom: '2026-01-01',
        lines: [
          { productId: icingId, variant: 'BASE', qtyPerCover: 400 },
          { productId: icingId, variant: 'GF_REMOVE', qtyPerCover: 0 },
          { productId: gfFlour!.id, variant: 'GF_ADD', qtyPerCover: 420 },
        ],
        companyId: COMPANY,
      });

      const plain = await expected.expectedForSession({
        bake: BAKE, siteId, onDate: '2026-06-01', covers: 10, companyId: COMPANY,
      });
      const withGf = await expected.expectedForSession({
        bake: BAKE, siteId, onDate: '2026-06-01', covers: 10,
        glutenFreeTables: 2, companyId: COMPANY,
      });
      const qty = (rows: typeof plain, name: string) =>
        rows.find((r) => r.productName === name)?.expectedQty ?? 0;

      expect(qty(plain, 'FB Icing sugar')).toBe(4000);
      expect(qty(withGf, 'FB Icing sugar')).toBe(3200);
      // The substitute appears — the thing the tester never saw.
      expect(qty(withGf, 'FB GF flour')).toBe(840);
    } finally {
      const db2 = getDb();
      await db2.delete(recipeLines).where(eq(recipeLines.productId, gfFlour!.id));
      await db2.delete(products).where(eq(products.id, gfFlour!.id));
    }
  });

  it('F-6: "No bake logs were submitted due to incorrect recipe data"', async () => {
    const result = await expected.expectedForSessionWithCoverage({
      bake: 'FB Cake That Does Not Exist',
      siteId, onDate: '2026-06-01', covers: 4, companyId: COMPANY,
    });
    // A named refusal, not an empty list under a toast that vanishes.
    expect(result.lines).toEqual([]);
    expect(result.blockers.map((b) => b.kind)).toEqual(['NO_RECIPE']);
    expect(result.blockers[0]!.message).toContain('FB Cake That Does Not Exist');
  });

  it('F-7: "Request to show benches under the kilo figures"', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/sites/${siteId}`,
      headers: auth(adminToken), payload: { benchesPerTable: 6 },
    });
    expect(res.statusCode).toBe(200);
    expect(Number(res.json().data.benchesPerTable)).toBe(6);

    // …and "not set" stays a real, distinguishable state.
    const cleared = await app.inject({
      method: 'PATCH', url: `/api/v1/sites/${siteId}`,
      headers: auth(adminToken), payload: { benchesPerTable: null },
    });
    expect(cleared.json().data.benchesPerTable).toBeNull();
  });

  it('F-8: client/server type drift on consumption lines', async () => {
    // The server validates `entryMode` / `remainingQty`; the client's line
    // type declared neither, so a "what's left" line was rejected at the
    // boundary — the last thing between a baker and a filed bake.
    // A "what's left" line is only defensible against an opening figure, so
    // book a sack in first. (E-3 above books and then reverses to zero.)
    const booked = await app.inject({
      method: 'POST',
      url: '/api/v1/goods-in',
      headers: auth(adminToken),
      payload: {
        siteId,
        idempotencyKey: `fb-aug12-f8-${siteId}`,
        lines: [{ productId: icingId, qtyPurchase: 1, unitCost: 30 }],
      },
    });
    expect(booked.statusCode, booked.body).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session-consumption',
      headers: auth(bakerToken),
      payload: {
        sessionId: `FB-AUG12-${Date.now()}`,
        siteId,
        sessionDate: '2026-08-12',
        bakerName: 'FB Tester',
        bake: 'FB Aug12 Cake',
        covers: 4,
        lines: [{ productId: icingId, entryMode: 'REMAINING', remainingQty: 250 }],
      },
    });
    expect(res.statusCode, res.body).toBe(201);

    // …and a line naming no quantity at all is still refused, rather than
    // being inferred as a zero count.
    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/session-consumption',
      headers: auth(bakerToken),
      payload: {
        sessionId: `FB-AUG12-EMPTY-${Date.now()}`,
        siteId,
        sessionDate: '2026-08-12',
        bakerName: 'FB Tester',
        covers: 4,
        lines: [{ productId: icingId, entryMode: 'REMAINING' }],
      },
    });
    expect(empty.statusCode).toBe(400);
  });
});
