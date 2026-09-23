/**
 * Stock-takes (P9, spec §A6). Real Postgres, isolated company.
 *
 * Covers: opening snapshots book stock; counts compute the right variance;
 * approval trues up on-hand and posts one adjustment (idempotent on re-approve);
 * a partial-scope (ITEM) take only touches the in-scope product.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  glPostingLog,
  itemCategories,
  products,
  sites,
  stockLevels,
  stockMovements,
  stockTakeLines,
  stockTakes,
} from '../../db/schema/index.js';
import { StockLevelService } from '../stock/stock-level.service.js';
import { StockTakeClosedError, StockTakeService } from './stock-take.service.js';

const COMPANY = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const svc = new StockTakeService();
const levels = new StockLevelService();
let siteId: string;
let flourId: string;
let sugarId: string;

async function clear(): Promise<void> {
  const db = getDb();
  const takes = await db.select({ id: stockTakes.id }).from(stockTakes).where(eq(stockTakes.companyId, COMPANY));
  for (const t of takes) await db.delete(stockTakeLines).where(eq(stockTakeLines.stockTakeId, t.id));
  await db.delete(stockTakes).where(eq(stockTakes.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

async function setLevel(productId: string, onHand: number): Promise<void> {
  await getDb().insert(stockLevels).values({
    companyId: COMPANY,
    productId,
    siteId,
    onHand: String(onHand),
  });
}

beforeAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  const [f] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'ST Flour', slug: 'st-flour', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.01' })
    .returning();
  const [s] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'ST Sugar', slug: 'st-sugar', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.01' })
    .returning();
  flourId = f!.id;
  sugarId = s!.id;
  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'st-site', name: 'ST Site', canonicalName: 'ST Site' })
    .returning();
  siteId = site!.id;
});

beforeEach(clear);

afterAll(async () => {
  const db = getDb();
  await clear();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

describe('open', () => {
  it('snapshots book stock for the scope', async () => {
    await setLevel(flourId, 5000);
    await setLevel(sugarId, 3000);
    const { lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    expect(lines).toHaveLength(2);
    const flourLine = lines.find((l) => l.productId === flourId)!;
    expect(Number(flourLine.bookQty)).toBe(5000);
  });

  // ── D-1b: the count screen must not need a second request to name a row ──
  it('D-1b: returns product identity ON each line', async () => {
    await setLevel(flourId, 5000);
    const { lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    const line = lines.find((l) => l.productId === flourId)!;
    expect(line.productName).toBe('ST Flour');
    expect(line.stockUom).toBe('g');
    expect(line.itemKind).toBe('INGREDIENT');
    expect(line).toHaveProperty('stockCode');
  });

  it('D-1b: GET also carries the identity, so a resumed take is legible too', async () => {
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    const got = await svc.get(take.id, COMPANY);
    expect(got!.lines[0]!.productName).toBe('ST Flour');
  });

  it('D-1b: the join never drops a line — every stock_take_line comes back', async () => {
    // `stock_take_lines.product_id` has an FK to `products`, so a genuinely
    // orphaned line cannot exist today. The join is nevertheless a LEFT join
    // and the mapper coalesces to null, so if that FK is ever relaxed a
    // nameless line degrades to "Unknown product" on the count sheet rather
    // than vanishing from it. This asserts the no-drop half, which is the
    // half a wrong (inner) join would break.
    await setLevel(flourId, 5000);
    await setLevel(sugarId, 3000);
    const { take, lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });

    const rows = await getDb()
      .select({ id: stockTakeLines.id })
      .from(stockTakeLines)
      .where(eq(stockTakeLines.stockTakeId, take.id));

    expect(lines).toHaveLength(rows.length);
    expect(lines.every((l) => l.productName !== undefined)).toBe(true);
  });
});

describe('counts + approval', () => {
  it('computes variance, trues up on-hand and posts one adjustment (idempotent)', async () => {
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    // Counted 4800 vs book 5000 → variance −200.
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 4800 }]);
    const got = await svc.get(take.id, COMPANY);
    expect(Number(got!.lines[0]!.variance)).toBe(-200);

    await svc.approve(take.id, COMPANY);
    // On-hand trued up to the counted value.
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(4800);

    // Exactly one SADJ posted; re-approve is a no-op.
    const sadj = () =>
      getDb().select({ id: glPostingLog.id }).from(glPostingLog).where(eq(glPostingLog.idempotencyKey, `SADJ-${take.id}-v1`));
    expect(await sadj()).toHaveLength(1);
    await svc.approve(take.id, COMPANY);
    expect(await sadj()).toHaveLength(1);
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(4800); // unchanged
  });

  it('is offline-idempotent on a re-submitted count batch', async () => {
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    await svc.recordCount({ stockTakeId: take.id, productId: flourId, countedQty: 4800, countIdempotencyKey: 'k1' });
    // Replay the same client key — must not overwrite with a different value.
    await svc.recordCount({ stockTakeId: take.id, productId: flourId, countedQty: 9999, countIdempotencyKey: 'k1' });
    const got = await svc.get(take.id, COMPANY);
    expect(Number(got!.lines[0]!.countedQty)).toBe(4800);
  });
});

// ── D-2: counts must not be silently destroyed, and a zeroed line is loud ───
describe('count fidelity and variance warnings (D-2)', () => {
  it('D-2: approving trues the ledger to the SUBMITTED figure, exactly', async () => {
    // 4 kg, in the product's own stock unit. The whole point of D-2 is that
    // this number survives the round trip unrounded.
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 4 }]);
    await svc.approve(take.id, COMPANY);
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(4);
  });

  it('D-2: a 0 count against a non-zero book figure raises a warning', async () => {
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 0 }]);

    const warnings = await svc.varianceWarnings(take.id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('COUNTED_TO_ZERO');
    expect(warnings[0]!.productName).toBe('ST Flour');
    expect(warnings[0]!.bookQty).toBe(5000);
    expect(warnings[0]!.message).toMatch(/counted as 0/i);
  });

  it('a 0 count against a 0 book figure is unremarkable — no warning', async () => {
    await setLevel(flourId, 0);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 0 }]);
    expect(await svc.varianceWarnings(take.id)).toHaveLength(0);
  });

  it('an uncounted line raises no warning — it has not been answered yet', async () => {
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    expect(await svc.varianceWarnings(take.id)).toHaveLength(0);
  });

  it('the take line carries the per-product count quantum (null by default)', async () => {
    await setLevel(flourId, 5000);
    const { lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    expect(lines[0]!.countQuantum).toBeNull();
  });

  it('a configured quantum reaches the line', async () => {
    const db = getDb();
    await db.update(products).set({ countQuantum: '100.0000' }).where(eq(products.id, flourId));
    await setLevel(flourId, 5000);
    const { lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    expect(Number(lines.find((l) => l.productId === flourId)!.countQuantum)).toBe(100);
    await db.update(products).set({ countQuantum: null }).where(eq(products.id, flourId));
  });

  // The count screen builds its "Count this item in ..." line from these two.
  // They have to arrive WITH the line: sourced from the separate product-map
  // lookup, a failure there would quietly downgrade head office's own wording
  // to the generic sentence, and nothing on screen would say it had.
  it('the take line carries the stock check instruction (null by default)', async () => {
    await setLevel(flourId, 5000);
    const { lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    const line = lines.find((l) => l.productId === flourId)!;
    expect(line.stockCheckInstruction).toBeNull();
    expect(line.stockUom).toBe('g');
  });

  // The count sheet is split into sections by this; without it on the line the
  // whole sheet collapses into one "Uncategorised" block that looks exactly
  // like a catalogue where nobody set categories.
  it('the take line carries the item category name (null by default)', async () => {
    await setLevel(flourId, 5000);
    const { lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    expect(lines.find((l) => l.productId === flourId)!.itemCategoryName).toBeNull();
  });

  it("a product's item category reaches the line by NAME", async () => {
    const db = getDb();
    const [cat] = await db
      .insert(itemCategories)
      .values({ companyId: COMPANY, name: 'ST Dry Stock' })
      .returning({ id: itemCategories.id });
    await db.update(products).set({ itemCategoryId: cat!.id }).where(eq(products.id, flourId));
    await setLevel(flourId, 5000);
    const { lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    expect(lines.find((l) => l.productId === flourId)!.itemCategoryName).toBe('ST Dry Stock');
    await db.update(products).set({ itemCategoryId: null }).where(eq(products.id, flourId));
    await db.delete(itemCategories).where(eq(itemCategories.id, cat!.id));
  });

  it("a product's own instruction reaches the line", async () => {
    const db = getDb();
    await db
      .update(products)
      .set({ stockCheckInstruction: 'Weigh the open sack, do not count it' })
      .where(eq(products.id, flourId));
    await setLevel(flourId, 5000);
    const { lines } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    expect(lines.find((l) => l.productId === flourId)!.stockCheckInstruction).toBe(
      'Weigh the open sack, do not count it',
    );
    await db.update(products).set({ stockCheckInstruction: null }).where(eq(products.id, flourId));
  });
});

describe('partial scope', () => {
  it('an ITEM-scope take only touches the in-scope product', async () => {
    await setLevel(flourId, 5000);
    await setLevel(sugarId, 3000);
    const { take, lines } = await svc.open({ siteId, scope: 'ITEM', scopeRef: flourId, companyId: COMPANY });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.productId).toBe(flourId);
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 5200 }]);
    await svc.approve(take.id, COMPANY);
    expect(Number(await levels.getOnHand(flourId, siteId, COMPANY))).toBe(5200); // trued up
    expect(Number(await levels.getOnHand(sugarId, siteId, COMPANY))).toBe(3000); // untouched
  });
});

// ── Several counters, one take (Sept 2026) ────────────────────────────────
describe('who counted what', () => {
  const sam = { userId: 'pin:sam', name: 'Sam' };
  const alex = { userId: 'pin:alex', name: 'Alex' };

  it('records who opened the take', async () => {
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY, openedBy: sam });
    expect(take.openedByName).toBe('Sam');
    expect(take.openedByUserId).toBe('pin:sam');
  });

  it("records each count against the person who saved it, and both are visible to either", async () => {
    await setLevel(flourId, 5000);
    await setLevel(sugarId, 3000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY, openedBy: sam });
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 4900 }], sam);
    await svc.recordCounts(take.id, [{ productId: sugarId, countedQty: 3000 }], alex);

    const { lines } = (await svc.get(take.id, COMPANY))!;
    const flour = lines.find((l) => l.productId === flourId)!;
    const sugar = lines.find((l) => l.productId === sugarId)!;
    expect([flour.countedByName, flour.countedByUserId]).toEqual(['Sam', 'pin:sam']);
    expect([sugar.countedByName, sugar.countedByUserId]).toEqual(['Alex', 'pin:alex']);
  });

  it('the last person to save a line becomes its counter', async () => {
    // The number on the line is theirs, so the name must be too. The screen
    // warns before anyone replaces someone else's count.
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 4900 }], sam);
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 4800 }], alex);
    const line = (await svc.get(take.id, COMPANY))!.lines.find((l) => l.productId === flourId)!;
    expect(Number(line.countedQty)).toBe(4800);
    expect(line.countedByName).toBe('Alex');
  });

  it('an uncounted line has no counter', async () => {
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY, openedBy: sam });
    const line = (await svc.get(take.id, COMPANY))!.lines[0]!;
    expect(line.countedByName).toBeNull();
    expect(line.countedByUserId).toBeNull();
  });

  it('refuses counts once the take is approved, rather than storing them unused', async () => {
    // Before two people shared a take this could barely happen; now one
    // counter can approve while the other is still saving. A count written to
    // an approved take would be kept and never applied — lost, silently.
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 4900 }], sam);
    await svc.approve(take.id, COMPANY);
    await expect(
      svc.recordCounts(take.id, [{ productId: flourId, countedQty: 1 }], alex),
    ).rejects.toBeInstanceOf(StockTakeClosedError);
    const line = (await svc.get(take.id, COMPANY))!.lines[0]!;
    expect(Number(line.countedQty)).toBe(4900);
    expect(line.countedByName).toBe('Sam');
  });
});

describe('list: progress for joining a take', () => {
  it('reports lines, counted lines, counters A→Z and the last count', async () => {
    await setLevel(flourId, 5000);
    await setLevel(sugarId, 3000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY, openedBy: { userId: 'pin:sam', name: 'Sam' } });
    await svc.recordCounts(take.id, [{ productId: sugarId, countedQty: 1 }], { userId: 'pin:sam', name: 'Sam' });
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 1 }], { userId: 'pin:alex', name: 'Alex' });

    const [row] = await svc.list({ siteId, status: 'OPEN', companyId: COMPANY });
    expect(row!.id).toBe(take.id);
    expect(row!.openedByName).toBe('Sam');
    expect(row!.lineCount).toBe(2);
    expect(row!.countedCount).toBe(2);
    expect(row!.counters).toEqual(['Alex', 'Sam']);
    expect(row!.lastCountedAt).toBeInstanceOf(Date);
  });

  it('an untouched take reports nothing counted, and no counters', async () => {
    await setLevel(flourId, 5000);
    await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    const [row] = await svc.list({ siteId, status: 'OPEN', companyId: COMPANY });
    expect(row!.lineCount).toBe(1);
    expect(row!.countedCount).toBe(0);
    expect(row!.counters).toEqual([]);
    expect(row!.lastCountedAt).toBeNull();
  });

  it('only OPEN takes are offered to join when asked for OPEN', async () => {
    await setLevel(flourId, 5000);
    const { take: done } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    await svc.approve(done.id, COMPANY);
    const { take: live } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    const open = await svc.list({ siteId, status: 'OPEN', companyId: COMPANY });
    expect(open.map((t) => t.id)).toEqual([live.id]);
  });
});

describe('idempotency keys: replays vs corrections', () => {
  it('a replay (same key) is ignored, but a correction (new key) lands', async () => {
    // The iPad used to send take+product as the key, so every later save of a
    // product looked like a replay and was dropped — no count could ever be
    // corrected. It now sends a key per save; a queued save resends its own.
    await setLevel(flourId, 5000);
    const { take } = await svc.open({ siteId, scope: 'FULL', companyId: COMPANY });
    const first = `${take.id}:${flourId}:save-1`;
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 4900, countIdempotencyKey: first }]);
    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 1, countIdempotencyKey: first }]);
    let line = (await svc.get(take.id, COMPANY))!.lines[0]!;
    expect(Number(line.countedQty)).toBe(4900);

    await svc.recordCounts(take.id, [{ productId: flourId, countedQty: 4950, countIdempotencyKey: `${take.id}:${flourId}:save-2` }]);
    line = (await svc.get(take.id, COMPANY))!.lines[0]!;
    expect(Number(line.countedQty)).toBe(4950);
  });
});
