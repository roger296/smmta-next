/**
 * Basket service (SPEC §14.3). Every mutating op re-prices through the pricing
 * engine and returns the COMPLETE basket, so the agent never infers state or
 * price from memory. Prices are never persisted on a line.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { baskets, basketLines, products } from '../../db/schema/index.js';
import { InboundService } from '../inbound/inbound.service.js';
import { PricingService } from '../pricing/pricing.service.js';

export class InsufficientStockError extends Error {
  constructor(public readonly sku: string, public readonly available: number, public readonly requested: number) {
    super(`insufficient stock for ${sku}: ${available} available, ${requested} requested`);
    this.name = 'InsufficientStockError';
  }
}

export interface BasketView {
  basketId: string;
  lines: Array<{
    lineId: string;
    sku: string;
    name: string | null;
    qty: number;
    pool: string;
    unitPricePence: number;
    lineTotalPence: number;
    savingsVsBasePence: number;
  }>;
  totalPence: number;
  totalSavingsPence: number;
  appliedCode: string | null;
}

export class BasketService {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private inbound = new InboundService();
  private pricing = new PricingService();

  async createBasket(userId?: string): Promise<string> {
    const [b] = await this.db
      .insert(baskets)
      .values({ companyId: this.companyId, userId: userId ?? null })
      .returning({ id: baskets.id });
    return b!.id;
  }

  private async availableFor(sku: string, pool: string): Promise<number> {
    const stock = await this.inbound.getStockAndEta(sku);
    if (pool === 'warehouse') return stock.warehouse.availableQty;
    const p = stock.inbound.find((i) => i.shipmentRef === pool);
    return p?.presaleAvailable ?? 0;
  }

  async addLine(basketId: string, sku: string, qty: number, pool = 'warehouse'): Promise<BasketView> {
    if (qty <= 0 || !Number.isInteger(qty)) throw new Error(`invalid qty ${qty}`);
    const [existing] = await this.db
      .select()
      .from(basketLines)
      .where(and(eq(basketLines.basketId, basketId), eq(basketLines.sku, sku), eq(basketLines.pool, pool)))
      .limit(1);
    const targetQty = (existing?.qty ?? 0) + qty;

    const available = await this.availableFor(sku, pool);
    if (targetQty > available) throw new InsufficientStockError(sku, available, targetQty);

    if (existing) {
      await this.db.update(basketLines).set({ qty: targetQty }).where(eq(basketLines.id, existing.id));
    } else {
      await this.db
        .insert(basketLines)
        .values({ companyId: this.companyId, basketId, sku, qty, pool });
    }
    await this.touch(basketId);
    return this.view(basketId);
  }

  async updateLine(lineId: string, qty: number): Promise<BasketView> {
    if (qty <= 0) throw new Error('qty must be ≥ 1; use remove for 0');
    const [line] = await this.db.select().from(basketLines).where(eq(basketLines.id, lineId)).limit(1);
    if (!line) throw new Error('LINE_NOT_FOUND');
    const available = await this.availableFor(line.sku, line.pool);
    if (qty > available) throw new InsufficientStockError(line.sku, available, qty);
    await this.db.update(basketLines).set({ qty }).where(eq(basketLines.id, lineId));
    await this.touch(line.basketId);
    return this.view(line.basketId);
  }

  async removeLine(lineId: string): Promise<BasketView> {
    const [line] = await this.db.select().from(basketLines).where(eq(basketLines.id, lineId)).limit(1);
    if (!line) throw new Error('LINE_NOT_FOUND');
    await this.db.delete(basketLines).where(eq(basketLines.id, lineId));
    await this.touch(line.basketId);
    return this.view(line.basketId);
  }

  async applyCode(basketId: string, code: string): Promise<BasketView> {
    await this.pricing.validateCode(code); // throws PricingError INVALID_CODE
    await this.db.update(baskets).set({ appliedCode: code, updatedAt: new Date() }).where(eq(baskets.id, basketId));
    return this.view(basketId);
  }

  async view(basketId: string): Promise<BasketView> {
    const [basket] = await this.db.select().from(baskets).where(eq(baskets.id, basketId)).limit(1);
    if (!basket) throw new Error('basket not found');
    const lines = await this.db.select().from(basketLines).where(eq(basketLines.basketId, basketId));

    const priced = await Promise.all(
      lines.map(async (l) => {
        const [product] = await this.db
          .select({ name: products.name })
          .from(products)
          .where(and(eq(products.companyId, this.companyId), eq(products.stockCode, l.sku)))
          .limit(1);
        const q = await this.pricing.quote({
          sku: l.sku,
          qty: l.qty,
          pool: l.pool,
          code: basket.appliedCode,
        });
        return {
          lineId: l.id,
          sku: l.sku,
          name: product?.name ?? null,
          qty: l.qty,
          pool: l.pool,
          unitPricePence: q.unitPricePence,
          lineTotalPence: q.lineTotalPence,
          savingsVsBasePence: q.savingsVsBasePence * l.qty,
        };
      }),
    );

    return {
      basketId,
      lines: priced,
      totalPence: priced.reduce((s, l) => s + l.lineTotalPence, 0),
      totalSavingsPence: priced.reduce((s, l) => s + l.savingsVsBasePence, 0),
      appliedCode: basket.appliedCode,
    };
  }

  private async touch(basketId: string): Promise<void> {
    await this.db.update(baskets).set({ updatedAt: new Date() }).where(eq(baskets.id, basketId));
  }
}
