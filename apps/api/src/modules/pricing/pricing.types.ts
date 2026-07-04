/**
 * Pricing engine types (SPEC §14.3, §15). Money is integer pence everywhere;
 * percentages are basis points (bp; 10000 = 100%). Internal-only fields end in
 * `Internal` and are stripped by `toCustomerFacing` before any route returns.
 */
import type { PreorderBand } from '../../db/schema/pricing.js';

export type TierApplied = 'single' | 'carton';
export type DiscountWinner = 'structural' | 'code' | 'none';
export type DiscountSource = 'carton' | 'preorder' | 'code';

export interface SavingItem {
  source: DiscountSource;
  savingPence: number;
}

export interface DiscountCodeInput {
  kind: 'percent' | 'fixed';
  valueBp?: number | null;
  valuePence?: number | null;
}

/** Everything the pure pricing math needs — resolved from the DB by the service. */
export interface QuoteInputs {
  sku: string;
  qty: number;
  pool: string; // 'warehouse' or an inbound shipment reference
  basePricePence: number;
  cartonSize: number | null;
  landedCostPence: number;
  rule: {
    preorderBands: PreorderBand[];
    cartonDiscountBp: number;
    maxStackBp: number;
    minContributionBp: number;
    variableFulfilmentPence: number;
    paymentFeeBp: number;
    quoteTtlMinutes: number;
  };
  /** Days to ETA for a pre-order pool; null for warehouse (no band). */
  daysToEta: number | null;
  code?: DiscountCodeInput | null;
  /** Milliseconds since epoch — passed in for deterministic quote expiry. */
  nowMs: number;
}

export interface PriceQuote {
  sku: string;
  qty: number;
  pool: string;
  currency: 'GBP';
  basePricePence: number;
  unitPricePence: number;
  lineTotalPence: number;
  tierApplied: TierApplied;
  cartonMultipleHint: string | null;
  savings: SavingItem[];
  savingsVsBasePence: number;
  discountWinner: DiscountWinner;
  quoteExpiresAt: string; // ISO
  // ---- internal-only (stripped by toCustomerFacing) ----
  preorderDiscountBpInternal: number;
  cartonDiscountBpInternal: number;
  structuralBpInternal: number;
  floorPricePenceInternal: number;
  clampedInternal: boolean;
}

/** The customer-facing shape: PriceQuote with every *Internal field removed. */
export type CustomerFacingQuote = Omit<
  PriceQuote,
  | 'preorderDiscountBpInternal'
  | 'cartonDiscountBpInternal'
  | 'structuralBpInternal'
  | 'floorPricePenceInternal'
  | 'clampedInternal'
>;
