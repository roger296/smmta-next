/**
 * Stock-take-lite (P26). Real Postgres, isolated company.
 *
 * Covers: a device's counts upsert idempotently; one counter ⇒ resolved; two
 * counters on the same item ⇒ conflict (never summed); a resolution clears it;
 * two people's custom lines collide by name; CSV excludes conflicts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { stocktakeLiteCounts, stocktakeLiteResolutions } from '../../db/schema/index.js';
import { StockTakeLiteService } from './stocktake-lite.service.js';

const COMPANY = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
const PERIOD = 'TEST-2026';
const SITE = 'liverpool';
const svc = new StockTakeLiteService();

async function clear(): Promise<void> {
  const db = getDb();
  await db.delete(stocktakeLiteCounts).where(eq(stocktakeLiteCounts.companyId, COMPANY));
  await db.delete(stocktakeLiteResolutions).where(eq(stocktakeLiteResolutions.companyId, COMPANY));
}

beforeEach(clear);
afterAll(async () => {
  await clear();
  await closeDatabase();
});

const item = (over: Partial<Parameters<typeof svc.sync>[0]['counts'][number]> = {}) => ({
  itemKey: 'dry-stock-caster-sugar',
  itemName: 'Caster Sugar',
  section: 'DRY STOCK',
  packSize: '25kg',
  quantity: 4,
  ...over,
});

describe('sync', () => {
  it('upserts a device line in place (idempotent on device+item)', async () => {
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-a', counterName: 'Sam', companyId: COMPANY, counts: [item({ quantity: 4 })] });
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-a', counterName: 'Sam', companyId: COMPANY, counts: [item({ quantity: 6 })] });
    const rows = await getDb().select().from(stocktakeLiteCounts).where(eq(stocktakeLiteCounts.companyId, COMPANY));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.quantity)).toBe(6);
  });

  it('zero is a real, stored count', async () => {
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-a', counterName: 'Sam', companyId: COMPANY, counts: [item({ quantity: 0 })] });
    const con = await svc.consolidate(PERIOD, SITE, COMPANY);
    expect(con.items).toHaveLength(1);
    expect(con.items[0]!.quantity).toBe(0);
    expect(con.items[0]!.status).toBe('RESOLVED');
  });
});

describe('consolidation', () => {
  it('one counter ⇒ resolved', async () => {
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-a', counterName: 'Sam', companyId: COMPANY, counts: [item({ quantity: 4 })] });
    const con = await svc.consolidate(PERIOD, SITE, COMPANY);
    expect(con.conflictCount).toBe(0);
    expect(con.items[0]!.status).toBe('RESOLVED');
    expect(con.items[0]!.quantity).toBe(4);
  });

  it('two counters on the same item ⇒ conflict, not summed', async () => {
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-a', counterName: 'Sam', companyId: COMPANY, counts: [item({ quantity: 4 })] });
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-b', counterName: 'Jo', companyId: COMPANY, counts: [item({ quantity: 2 })] });
    const con = await svc.consolidate(PERIOD, SITE, COMPANY);
    expect(con.conflictCount).toBe(1);
    const it0 = con.items[0]!;
    expect(it0.status).toBe('CONFLICT');
    expect(it0.quantity).toBeNull();
    expect(it0.contributors).toHaveLength(2);
  });

  it('a resolution clears the conflict with the chosen figure', async () => {
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-a', counterName: 'Sam', companyId: COMPANY, counts: [item({ quantity: 4 })] });
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-b', counterName: 'Jo', companyId: COMPANY, counts: [item({ quantity: 2 })] });
    const before = await svc.consolidate(PERIOD, SITE, COMPANY);
    await svc.resolve({ period: PERIOD, siteSlug: SITE, groupKey: before.items[0]!.groupKey, resolvedQty: 5, resolvedBy: 'HO', companyId: COMPANY });
    const after = await svc.consolidate(PERIOD, SITE, COMPANY);
    expect(after.conflictCount).toBe(0);
    expect(after.items[0]!.status).toBe('RESOLVED');
    expect(after.items[0]!.quantity).toBe(5);
    expect(after.items[0]!.resolvedBy).toBe('HO');
  });

  it('two people adding the same custom line collide by name', async () => {
    const custom = (q: number, key: string) => ({ itemKey: key, itemName: 'Burnt Honey Syrup', quantity: q, isCustom: true });
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-a', counterName: 'Sam', companyId: COMPANY, counts: [custom(3, 'custom:aaa')] });
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-b', counterName: 'Jo', companyId: COMPANY, counts: [custom(1, 'custom:bbb')] });
    const con = await svc.consolidate(PERIOD, SITE, COMPANY);
    expect(con.items).toHaveLength(1);
    expect(con.items[0]!.status).toBe('CONFLICT');
  });
});

describe('csv', () => {
  it('emits resolved rows and lists conflicts separately', async () => {
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-a', counterName: 'Sam', companyId: COMPANY, counts: [
      item({ itemKey: 'k1', itemName: 'Caster Sugar', quantity: 4 }),
      item({ itemKey: 'k2', itemName: 'Icing Sugar', quantity: 2 }),
    ] });
    // conflict on Icing Sugar
    await svc.sync({ period: PERIOD, siteSlug: SITE, deviceId: 'dev-b', counterName: 'Jo', companyId: COMPANY, counts: [item({ itemKey: 'k2', itemName: 'Icing Sugar', quantity: 9 })] });
    const csv = await svc.exportCsv(PERIOD, SITE, COMPANY);
    expect(csv).toContain('Caster Sugar,4');
    expect(csv).not.toContain('Icing Sugar,'); // conflicted → excluded from body
    expect(csv).toContain('# CONFLICT');
    expect(csv).toContain('Icing Sugar');
  });
});
