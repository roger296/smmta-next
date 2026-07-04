/**
 * Pricing rules config (SPEC §15.7, §15.2, §15.3, §16.1).
 *
 * Commercial policy as DATA, not code: changing bands, carton %, or floor
 * parameters must never require a deploy. One default row (`category = NULL`)
 * plus optional per-product-category overrides. All percentages are stored as
 * BASIS POINTS (integers, 10000 = 100%) so fractional rates (e.g. a 2% payment
 * fee = 200 bp) stay integer-exact — no floats near money. The pricing engine
 * (Prompt 5) is the sole consumer.
 */
import { pgTable, uuid, text, integer, timestamp, jsonb, unique } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';

/** One pre-order band: applies when days-to-ETA ≥ `minDaysToEta`; the engine
 *  picks the band with the largest satisfied `minDaysToEta`. */
export interface PreorderBand {
  minDaysToEta: number;
  discountBp: number;
}

export const pricingRules = pgTable(
  'pricing_rules',
  {
    id: pk(),
    companyId: companyId(),
    /** NULL = the default ruleset; otherwise the product category slug it overrides. */
    category: text('category'),
    /** Pre-order bands (§15.2), highest minDaysToEta wins. */
    preorderBands: jsonb('preorder_bands').$type<PreorderBand[]>().notNull(),
    /** Carton tier discount (§15.1, ~10% = 1000 bp). */
    cartonDiscountBp: integer('carton_discount_bp').notNull().default(1000),
    /** Max structural stack (§15.3, 30% = 3000 bp). */
    maxStackBp: integer('max_stack_bp').notNull().default(3000),
    // ---- Floor parameters (§15.3): min_price = landed_cost + variable_fulfilment
    //      + payment_fees + min_contribution. landed_cost is per-SKU (product
    //      data, Prompt 5); the rest live here. ----
    minContributionBp: integer('min_contribution_bp').notNull().default(1500),
    variableFulfilmentPence: integer('variable_fulfilment_pence').notNull().default(0),
    paymentFeeBp: integer('payment_fee_bp').notNull().default(200),
    /** Warehouse stock band threshold (§14.1): ≤ this and > 0 = low_stock. */
    lowStockThreshold: integer('low_stock_threshold').notNull().default(10),
    /** Quote validity (§15.7, 30 min) — bands move daily with ETA. */
    quoteTtlMinutes: integer('quote_ttl_minutes').notNull().default(30),
    /** Any line with ETA beyond this many days → bank-payment-only (§16.1). */
    bankOnlyEtaDays: integer('bank_only_eta_days').notNull().default(30),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One rule row per (company, category); NULL category = the default, and
    // NULLS NOT DISTINCT keeps that default unique.
    uqPricingCategory: unique('uq_pricing_rules_category')
      .on(t.companyId, t.category)
      .nullsNotDistinct(),
  }),
);
