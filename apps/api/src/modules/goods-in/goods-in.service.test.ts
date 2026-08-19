/**
 * Goods-in / receiving (P8, spec §A7). Real Postgres, isolated company.
 *
 * Covers: a full receipt updates on-hand in stock_uom (purchase→stock
 * conversion); a partial receipt leaves the matched proposal short (UNDER,
 * remaining correct); an over-receipt flags OVER; the GRN posts once to Xero
 * (dry-run) and a re-confirm with the same key is a no-op.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  glPostingLog,
  goodsInReceiptLines,
  goodsInReceipts,
  products,
  reorderProposals,
  sites,
  stockMovements,
  stockLevels,
} from '../../db/schema/index.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { GoodsInService } from './goods-in.service.js';

const COMPANY = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
const svc = new GoodsInService();
const levels = new StockLevelService();
let siteId: string;
let flourId: string;

async function clearTx(): Promise<void> {
  const db = getDb();
  // receipts/lines (FK) then movements/levels for the company.
  const receipts = await db
    .select({ id: goodsInReceipts.id })
    .from(goodsInReceipts)
    .where(eq(goodsInReceipts.companyId, COMPANY));
  for (const r of receipts) {
    await db.delete(goodsInReceiptLines).where(eq(goodsInReceiptLines.receiptId, r.id));
  }
  await db.delete(goodsInReceipts).where(eq(goodsInReceipts.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(reorderProposals).where(eq(reorderProposals.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await clearTx();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  const [p] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'GI Flour',
      slug: 'gi-flour',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
      purchaseUom: 'bag',
      purchaseToStockFactor: '1000', // 1 bag = 1000 g
    })
    .returning();
  flourId = p!.id;
  const [s] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'gi-site', name: 'GI Site', canonicalName: 'GI Site' })
    .returning();
  siteId = s!.id;
});

beforeEach(clearTx);

afterAll(async () => {
  const db = getDb();
  await clearTx();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

describe('GoodsInService.receive', () => {
  it('converts purchase units to stock units and raises on-hand', async () => {
    const res = await svc.receive({
      siteId,
      idempotencyKey: 'gi-full-1',
      lines: [{ productId: flourId, qtyPurchase: 5, unitCost: 2 }], // 5 bags @ £2
      companyId: COMPANY,
    });
    expect(res.alreadyExisted).toBe(false);
    expect(Number(res.lines[0]!.qtyStock)).toBe(5000); // 5 × 1000 g
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(5000);
    expect(Number(res.receipt.totalStockValue)).toBe(10);
  });

  it('flags an UNDER variance and leaves the ordered remainder', async () => {
    const db = getDb();
    const [proposal] = await db
      .insert(reorderProposals)
      .values({
        companyId: COMPANY,
        productId: flourId,
        siteId,
        suggestedQtyStock: '10000',
        suggestedQtyPurchase: '10', // ordered 10 bags
        status: 'PLACED',
      })
      .returning();
    const res = await svc.receive({
      siteId,
      reorderProposalId: proposal!.id,
      idempotencyKey: 'gi-partial-1',
      lines: [{ productId: flourId, qtyPurchase: 4, unitCost: 2 }], // only 4 of 10 arrived
      companyId: COMPANY,
    });
    expect(res.receipt.variance).toBe('UNDER');
    const line = res.lines[0]!;
    expect(Number(line.expectedQtyPurchase)).toBe(10);
    expect(Number(line.expectedQtyPurchase) - Number(line.qtyPurchase)).toBe(6); // remaining
  });

  it('flags an OVER variance', async () => {
    const db = getDb();
    const [proposal] = await db
      .insert(reorderProposals)
      .values({
        companyId: COMPANY,
        productId: flourId,
        siteId,
        suggestedQtyStock: '3000',
        suggestedQtyPurchase: '3',
        status: 'PLACED',
      })
      .returning();
    const res = await svc.receive({
      siteId,
      reorderProposalId: proposal!.id,
      idempotencyKey: 'gi-over-1',
      lines: [{ productId: flourId, qtyPurchase: 5, unitCost: 2 }], // 5 > 3 ordered
      companyId: COMPANY,
    });
    expect(res.receipt.variance).toBe('OVER');
  });

  it('posts the GRN to Xero once and is idempotent on re-confirm', async () => {
    const input = {
      siteId,
      idempotencyKey: 'gi-idem-1',
      lines: [{ productId: flourId, qtyPurchase: 2, unitCost: 3 }],
      companyId: COMPANY,
    };
    const first = await svc.receive(input);
    const second = await svc.receive(input);
    expect(first.alreadyExisted).toBe(false);
    expect(second.alreadyExisted).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id); // same receipt, no re-apply

    // Exactly one GRN gl_posting_log row for this receipt.
    const glRows = await getDb()
      .select({ id: glPostingLog.id })
      .from(glPostingLog)
      .where(eq(glPostingLog.idempotencyKey, 'GRN-gi-idem-1-v1'));
    expect(glRows).toHaveLength(1);

    // On-hand reflects a single application (2 bags × 1000 g).
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(2000);
  });
});

// ── E-3: undo, as a reversing receipt (Aug-2026 feedback set) ───────────────
describe('GoodsInService.reverse', () => {
  it('E-3: zeroes the net movement for the product/site', async () => {
    const booked = await svc.receive({
      siteId,
      idempotencyKey: 'gi-rev-1',
      lines: [{ productId: flourId, qtyPurchase: 100, unitCost: 2 }], // 100 kg
      companyId: COMPANY,
    });
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(100_000);

    const res = await svc.reverse({ receiptId: booked.receipt.id, companyId: COMPANY });
    expect(res).not.toBeNull();
    // Net zero — the ledger balances, rather than the original being erased.
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(0);
  });

  it('E-3: leaves the ORIGINAL receipt row intact — history is not mutated', async () => {
    const booked = await svc.receive({
      siteId,
      idempotencyKey: 'gi-rev-2',
      lines: [{ productId: flourId, qtyPurchase: 4, unitCost: 2 }],
      companyId: COMPANY,
    });
    const before = booked.receipt;

    const res = await svc.reverse({
      receiptId: before.id,
      reason: 'Wrong venue',
      userId: 'pin:abc',
      companyId: COMPANY,
    });

    const after = await getDb().query.goodsInReceipts.findFirst({
      where: eq(goodsInReceipts.id, before.id),
    });
    expect(after).toBeDefined();
    // The booked figures are exactly as they were.
    expect(after!.totalStockValue).toBe(before.totalStockValue);
    expect(after!.siteId).toBe(before.siteId);
    // And it now points at its reversal, with the audit trail.
    expect(after!.reversedByReceiptId).toBe(res!.reversal.id);
    expect(after!.reversedAt).not.toBeNull();
    expect(after!.reversalReason).toBe('Wrong venue');
    expect(after!.reversedByUserId).toBe('pin:abc');
    // The reversal points back.
    expect(res!.reversal.reversalOfReceiptId).toBe(before.id);
  });

  it('E-3: is idempotent — a double-tapped Undo reverses once', async () => {
    const booked = await svc.receive({
      siteId,
      idempotencyKey: 'gi-rev-3',
      lines: [{ productId: flourId, qtyPurchase: 10, unitCost: 2 }],
      companyId: COMPANY,
    });

    const first = await svc.reverse({ receiptId: booked.receipt.id, companyId: COMPANY });
    const second = await svc.reverse({ receiptId: booked.receipt.id, companyId: COMPANY });

    expect(first!.alreadyExisted).toBe(false);
    expect(second!.alreadyExisted).toBe(true);
    expect(second!.reversal.id).toBe(first!.reversal.id);
    // Still net zero, not double-reversed into negative stock.
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(0);
  });

  it('E-3: posts exactly one reversing GL entry', async () => {
    const booked = await svc.receive({
      siteId,
      idempotencyKey: 'gi-rev-4',
      lines: [{ productId: flourId, qtyPurchase: 7, unitCost: 3 }],
      companyId: COMPANY,
    });
    await svc.reverse({ receiptId: booked.receipt.id, companyId: COMPANY });
    await svc.reverse({ receiptId: booked.receipt.id, companyId: COMPANY });

    const key = `GRN-reversal:${booked.receipt.id}-v1`;
    const posted = await getDb()
      .select({ id: glPostingLog.id })
      .from(glPostingLog)
      .where(eq(glPostingLog.idempotencyKey, key));
    expect(posted).toHaveLength(1);
  });

  it('refuses to reverse a reversal — that would re-book the delivery', async () => {
    const booked = await svc.receive({
      siteId,
      idempotencyKey: 'gi-rev-5',
      lines: [{ productId: flourId, qtyPurchase: 2, unitCost: 1 }],
      companyId: COMPANY,
    });
    const rev = await svc.reverse({ receiptId: booked.receipt.id, companyId: COMPANY });
    await expect(
      svc.reverse({ receiptId: rev!.reversal.id, companyId: COMPANY }),
    ).rejects.toThrow(/itself a reversal/i);
  });

  it('returns null for a receipt that does not exist', async () => {
    const res = await svc.reverse({
      receiptId: '00000000-0000-4000-8000-000000000000',
      companyId: COMPANY,
    });
    expect(res).toBeNull();
  });
});
