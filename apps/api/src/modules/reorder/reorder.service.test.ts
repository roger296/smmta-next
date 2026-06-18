/**
 * Automatic reordering engine (P7, spec §A7). Real Postgres, isolated company.
 *
 * Covers: a decrement crossing the reorder point raises exactly one
 * replenishment (idempotent); par + pack-size rounding; auto-place vs propose
 * routing (API_CONNECTOR → PLACED, EMAIL_PO → EMAILED, else PROPOSED); the
 * daily sweep catches untouched low items; the email PO renders (and is never
 * sent during the build).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  products,
  reorderProposals,
  sites,
  stockLevels,
  supplierProducts,
  suppliers,
} from '../../db/schema/index.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { ReorderService } from './reorder.service.js';
import { runReorderSweep } from './reorder.sweep.js';
import { renderEmailPO } from './email-po.js';

const COMPANY = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const levels = new StockLevelService();
const reorder = new ReorderService();
let siteId: string;

interface Built {
  productId: string;
  supplierId: string | null;
}

async function build(opts: {
  slug: string;
  factor?: number;
  packSize?: number;
  reorderPoint: number;
  par?: number;
  onHand: number;
  supplier?: { channel: 'EMAIL_PO' | 'API_CONNECTOR'; autoPlace: boolean };
}): Promise<Built> {
  const db = getDb();
  const [p] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: opts.slug,
      slug: opts.slug,
      itemKind: 'INGREDIENT',
      stockUom: 'g',
      purchaseUom: 'bag',
      purchasePackSize: String(opts.packSize ?? 1),
      purchaseToStockFactor: String(opts.factor ?? 1000),
    })
    .returning();
  let supplierId: string | null = null;
  if (opts.supplier) {
    const [s] = await db
      .insert(suppliers)
      .values({
        companyId: COMPANY,
        name: `Sup ${opts.slug}`,
        slug: `sup-${opts.slug}`,
        orderChannel: opts.supplier.channel,
        autoPlace: opts.supplier.autoPlace,
        orderEmail: 'orders@sup.example',
      })
      .returning();
    supplierId = s!.id;
    await db.insert(supplierProducts).values({
      companyId: COMPANY,
      productId: p!.id,
      supplierId,
      supplierSku: `SKU-${opts.slug}`,
      costGbp: '1.50',
    });
  }
  await db.insert(stockLevels).values({
    companyId: COMPANY,
    productId: p!.id,
    siteId,
    onHand: String(opts.onHand),
    reorderPoint: String(opts.reorderPoint),
    reorderUpTo: opts.par != null ? String(opts.par) : null,
  });
  return { productId: p!.id, supplierId };
}

beforeAll(async () => {
  const db = getDb();
  const [s] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'ro-site', name: 'RO Site', canonicalName: 'RO Site' })
    .returning();
  siteId = s!.id;
});

beforeEach(async () => {
  const db = getDb();
  await db.delete(reorderProposals).where(eq(reorderProposals.companyId, COMPANY));
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.companyId, COMPANY));
});

afterAll(async () => {
  const db = getDb();
  await db.delete(reorderProposals).where(eq(reorderProposals.companyId, COMPANY));
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.companyId, COMPANY));
  await closeDatabase();
});

async function proposalsFor(productId: string) {
  return getDb()
    .select()
    .from(reorderProposals)
    .where(eq(reorderProposals.productId, productId));
}

describe('decrement trigger', () => {
  it('creates exactly one replenishment when a sale crosses the reorder point, idempotently', async () => {
    const { productId } = await build({ slug: 'flour', reorderPoint: 2000, par: 8000, onHand: 8500 });
    // Sale drops on-hand to 1500 (below the 2000 point) → hook evaluates.
    await levels.applyMovement({
      productId, siteId, qtyDelta: -7000, movementType: 'SALE',
      sourceSystem: 'test', sourceKey: 'd1', contentHash: 'h1', companyId: COMPANY,
    });
    expect(await proposalsFor(productId)).toHaveLength(1);
    // A second decrement while still below point must not create a duplicate.
    await levels.applyMovement({
      productId, siteId, qtyDelta: -100, movementType: 'SALE',
      sourceSystem: 'test', sourceKey: 'd2', contentHash: 'h2', companyId: COMPANY,
    });
    expect(await proposalsFor(productId)).toHaveLength(1);
  });
});

describe('quantity math', () => {
  it('orders up to par and rounds up to the supplier pack size', async () => {
    // factor 1000 (1 bag = 1000 g), pack size 2 (order in 2-bag multiples).
    // par 8000, on-hand 1000 → raw 7000 g = 7 bags → round up to 8 bags = 8000 g.
    const { productId } = await build({
      slug: 'sugar', factor: 1000, packSize: 2, reorderPoint: 2000, par: 8000, onHand: 1000,
    });
    const res = await reorder.evaluate(productId, siteId, { companyId: COMPANY });
    expect(res.created).toBe(true);
    const [proposal] = await proposalsFor(productId);
    expect(Number(proposal!.suggestedQtyPurchase)).toBe(8);
    expect(Number(proposal!.suggestedQtyStock)).toBe(8000);
  });
});

describe('placement routing', () => {
  it('auto-place EMAIL_PO → EMAILED with a rendered PO', async () => {
    const { productId } = await build({
      slug: 'salt', reorderPoint: 100, par: 500, onHand: 50,
      supplier: { channel: 'EMAIL_PO', autoPlace: true },
    });
    await reorder.evaluate(productId, siteId, { companyId: COMPANY });
    const [p] = await proposalsFor(productId);
    expect(p!.status).toBe('EMAILED');
    expect(p!.renderedPo).toBeTruthy();
  });

  it('auto-place API_CONNECTOR → PLACED with a supplier ref', async () => {
    const { productId } = await build({
      slug: 'yeast', reorderPoint: 100, par: 500, onHand: 50,
      supplier: { channel: 'API_CONNECTOR', autoPlace: true },
    });
    await reorder.evaluate(productId, siteId, { companyId: COMPANY });
    const [p] = await proposalsFor(productId);
    expect(p!.status).toBe('PLACED');
    expect(p!.supplierOrderRef).toBeTruthy();
  });

  it('propose-for-approval supplier → PROPOSED', async () => {
    const { productId } = await build({
      slug: 'butter', reorderPoint: 100, par: 500, onHand: 50,
      supplier: { channel: 'EMAIL_PO', autoPlace: false },
    });
    await reorder.evaluate(productId, siteId, { companyId: COMPANY });
    const [p] = await proposalsFor(productId);
    expect(p!.status).toBe('PROPOSED');
  });
});

describe('daily sweep', () => {
  it('raises proposals for low items that no decrement touched', async () => {
    const { productId } = await build({ slug: 'cocoa', reorderPoint: 1000, par: 5000, onHand: 800 });
    // No movement applied — the sweep must still catch it.
    const result = await runReorderSweep(COMPANY);
    expect(result.created).toBeGreaterThanOrEqual(1);
    expect(await proposalsFor(productId)).toHaveLength(1);
  });
});

describe('email PO render', () => {
  it('renders a PO document (never sent during the build)', () => {
    const doc = renderEmailPO({
      supplierName: 'ACME Flour',
      orderEmail: 'orders@acme.example',
      siteName: 'Birmingham',
      lines: [{ supplierSku: 'F1', productName: 'White flour', qty: 5, uom: 'bag', unitCost: 2.5 }],
    });
    expect(doc.to).toBe('orders@acme.example');
    expect(doc.total).toBe(12.5);
    expect(doc.body).toContain('White flour');
  });
});
