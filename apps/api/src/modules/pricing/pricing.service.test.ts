/**
 * PricingService integration tests (Prompt 5). Real Postgres at DATABASE_URL.
 * Seeds its own 'PRC-'-prefixed product + pool, passes nowMs for determinism.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  products,
  pricingRules,
  inboundShipments,
  inboundShipmentLines,
  discountCodes,
} from '../../db/schema/index.js';
import { PricingService, PricingError } from './pricing.service.js';

const COMPANY = getSingletonCompanyId();
const pricing = new PricingService();
const NOW = Date.parse('2026-07-04T00:00:00Z');
const DAY = 86_400_000;

const SKU = 'PRC-PLA-BLK';
const POOL = 'PRC-POOL-70';

beforeAll(async () => {
  const db = getDb();
  await db
    .insert(pricingRules)
    .values({ companyId: COMPANY, category: null, preorderBands: [
      { minDaysToEta: 60, discountBp: 2000 },
      { minDaysToEta: 30, discountBp: 1500 },
      { minDaysToEta: 14, discountBp: 1000 },
      { minDaysToEta: 0, discountBp: 500 },
    ] })
    .onConflictDoNothing();

  await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'Pricing Test PLA',
      stockCode: SKU,
      minSellingPrice: '19.99',
      cartonSize: 24,
      landedCostPence: 900,
    })
    .onConflictDoNothing();

  const eta = new Date(NOW + 70 * DAY);
  const [ship] = await db
    .insert(inboundShipments)
    .values({ companyId: COMPANY, reference: POOL, etaOriginal: eta, eta, status: 'in_transit', bufferPct: 8 })
    .returning({ id: inboundShipments.id });
  await db
    .insert(inboundShipmentLines)
    .values({ companyId: COMPANY, shipmentId: ship!.id, sku: SKU, qtyManifested: 480 });

  await db
    .insert(discountCodes)
    .values({ companyId: COMPANY, code: 'PRC-SAVE12', kind: 'percent', valueBp: 1200, active: true })
    .onConflictDoNothing();
});

afterEach(() => {});
afterAll(async () => {
  const db = getDb();
  await db.delete(inboundShipmentLines).where(eq(inboundShipmentLines.sku, SKU));
  await db.delete(inboundShipments).where(like(inboundShipments.reference, 'PRC-%'));
  await db.delete(products).where(and(eq(products.companyId, COMPANY), like(products.stockCode, 'PRC-%')));
  await db.delete(discountCodes).where(like(discountCodes.code, 'PRC-%'));
  await closeDatabase();
});

describe('PricingService.quote', () => {
  it('quotes warehouse base price with no discount', async () => {
    const q = await pricing.quote({ sku: SKU, qty: 1, pool: 'warehouse', nowMs: NOW });
    expect(q.basePricePence).toBe(1999);
    expect(q.unitPricePence).toBe(1999);
    expect(q.discountWinner).toBe('none');
  });

  it('quotes a full carton off the 70-day pool at the stacked price (£13.99)', async () => {
    const q = await pricing.quote({ sku: SKU, qty: 24, pool: POOL, nowMs: NOW });
    expect(q.tierApplied).toBe('carton');
    expect(q.unitPricePence).toBe(1399);
    expect(q.savingsVsBasePence).toBe(600);
    // 30-minute quote validity.
    expect(Date.parse(q.quoteExpiresAt) - NOW).toBe(30 * 60_000);
  });

  it('applies a valid code via best-of; rejects an invalid one', async () => {
    const q = await pricing.quote({ sku: SKU, qty: 1, pool: 'warehouse', code: 'PRC-SAVE12', nowMs: NOW });
    expect(q.discountWinner).toBe('code');
    expect(q.unitPricePence).toBe(1999 - 240); // 12% of 1999 = 240

    await expect(pricing.quote({ sku: SKU, qty: 1, code: 'NOPE', nowMs: NOW })).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
  });

  it('throws INVALID_SKU and POOL_UNAVAILABLE appropriately', async () => {
    await expect(pricing.quote({ sku: 'PRC-NOPE', qty: 1, nowMs: NOW })).rejects.toBeInstanceOf(PricingError);
    await expect(pricing.quote({ sku: SKU, qty: 1, pool: 'PRC-GHOST', nowMs: NOW })).rejects.toMatchObject({
      code: 'POOL_UNAVAILABLE',
    });
  });

  it('quoteCustomerFacing strips every *Internal field', async () => {
    const cf = (await pricing.quoteCustomerFacing({ sku: SKU, qty: 24, pool: POOL, nowMs: NOW })) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(cf)) expect(key.endsWith('Internal')).toBe(false);
    expect(cf.unitPricePence).toBe(1399);
  });
});
