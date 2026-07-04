/**
 * PricingService (SPEC §15.7) — the single price computation path for the
 * storefront, basket, and sales agent. Resolves product + pricing_rules + pool
 * ETA + optional code from the DB, then delegates to the pure engine. No price
 * is computed anywhere else.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { products, pricingRules, inboundShipments, discountCodes } from '../../db/schema/index.js';
import { computeQuote, toCustomerFacing } from './pricing.engine.js';
import type { CustomerFacingQuote, DiscountCodeInput, PriceQuote, QuoteInputs } from './pricing.types.js';

/** Error codes align with the sales-agent envelope (§14.2). */
export type PricingErrorCode = 'INVALID_SKU' | 'POOL_UNAVAILABLE' | 'INVALID_CODE';

export class PricingError extends Error {
  constructor(public readonly code: PricingErrorCode, message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

const DAY_MS = 86_400_000;

export interface QuoteRequest {
  sku: string;
  qty: number;
  pool?: string; // 'warehouse' (default) or an inbound shipment reference
  code?: string | null;
  /** Override "now" for deterministic tests; defaults to Date.now(). */
  nowMs?: number;
}

export class PricingService {
  private db = getDb();
  private companyId = getSingletonCompanyId();

  private async resolveRule(): Promise<QuoteInputs['rule']> {
    const [rule] = await this.db
      .select()
      .from(pricingRules)
      .where(and(eq(pricingRules.companyId, this.companyId), isNull(pricingRules.category)))
      .limit(1);
    if (!rule) {
      // Sensible defaults if no rule row is configured (SPEC §15.2 bands).
      return {
        preorderBands: [
          { minDaysToEta: 60, discountBp: 2000 },
          { minDaysToEta: 30, discountBp: 1500 },
          { minDaysToEta: 14, discountBp: 1000 },
          { minDaysToEta: 0, discountBp: 500 },
        ],
        cartonDiscountBp: 1000,
        maxStackBp: 3000,
        minContributionBp: 1500,
        variableFulfilmentPence: 0,
        paymentFeeBp: 200,
        quoteTtlMinutes: 30,
      };
    }
    return {
      preorderBands: rule.preorderBands,
      cartonDiscountBp: rule.cartonDiscountBp,
      maxStackBp: rule.maxStackBp,
      minContributionBp: rule.minContributionBp,
      variableFulfilmentPence: rule.variableFulfilmentPence,
      paymentFeeBp: rule.paymentFeeBp,
      quoteTtlMinutes: rule.quoteTtlMinutes,
    };
  }

  /** Days to ETA for a pool, or null for warehouse. Throws POOL_UNAVAILABLE for
   *  an unknown or already-arrived pool. */
  private async resolveDaysToEta(sku: string, pool: string, nowMs: number): Promise<number | null> {
    if (pool === 'warehouse') return null;
    const [shipment] = await this.db
      .select({ eta: inboundShipments.eta, arrivedAt: inboundShipments.arrivedAt })
      .from(inboundShipments)
      .where(and(eq(inboundShipments.companyId, this.companyId), eq(inboundShipments.reference, pool)))
      .limit(1);
    if (!shipment || shipment.arrivedAt) {
      throw new PricingError('POOL_UNAVAILABLE', `pool ${pool} is not available for pre-order`);
    }
    const days = Math.ceil((shipment.eta.getTime() - nowMs) / DAY_MS);
    if (days <= 0) {
      // ETA in the past but not yet marked arrived — window is effectively closed.
      throw new PricingError('POOL_UNAVAILABLE', `pool ${pool} pre-order window has closed`);
    }
    return days;
  }

  async validateCode(code: string): Promise<DiscountCodeInput> {
    const [row] = await this.db
      .select()
      .from(discountCodes)
      .where(and(eq(discountCodes.companyId, this.companyId), eq(discountCodes.code, code)))
      .limit(1);
    if (!row || !row.active || (row.expiresAt && row.expiresAt.getTime() < Date.now())) {
      throw new PricingError('INVALID_CODE', `discount code ${code} is not valid`);
    }
    return { kind: row.kind, valueBp: row.valueBp, valuePence: row.valuePence };
  }

  async quote(req: QuoteRequest): Promise<PriceQuote> {
    const nowMs = req.nowMs ?? Date.now();
    const pool = req.pool ?? 'warehouse';

    const [product] = await this.db
      .select({
        minSellingPrice: products.minSellingPrice,
        cartonSize: products.cartonSize,
        landedCostPence: products.landedCostPence,
      })
      .from(products)
      .where(and(eq(products.companyId, this.companyId), eq(products.stockCode, req.sku)))
      .limit(1);
    if (!product || product.minSellingPrice == null) {
      throw new PricingError('INVALID_SKU', `no priced product for sku ${req.sku}`);
    }

    const basePricePence = Math.round(parseFloat(product.minSellingPrice) * 100);
    const rule = await this.resolveRule();
    const daysToEta = await this.resolveDaysToEta(req.sku, pool, nowMs);
    const code = req.code ? await this.validateCode(req.code) : null;

    return computeQuote({
      sku: req.sku,
      qty: req.qty,
      pool,
      basePricePence,
      cartonSize: product.cartonSize,
      landedCostPence: product.landedCostPence ?? 0,
      rule,
      daysToEta,
      code,
      nowMs,
    });
  }

  /** The only quote shape a route may return — internal fields stripped. */
  async quoteCustomerFacing(req: QuoteRequest): Promise<CustomerFacingQuote> {
    return toCustomerFacing(await this.quote(req));
  }
}
