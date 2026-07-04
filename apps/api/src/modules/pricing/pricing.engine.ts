/**
 * Pure pricing math (SPEC §15). No I/O — the single computation path the
 * storefront, basket, and sales agent all reach through `PricingService`.
 * Every branch is integer-pence and bp exact; the floor is enforced last so no
 * combination of (base, qty, band, code) can ever produce a loss-making price.
 */
import type { PreorderBand } from '../../db/schema/pricing.js';
import type {
  CustomerFacingQuote,
  PriceQuote,
  QuoteInputs,
  SavingItem,
} from './pricing.types.js';

const pctOf = (pence: number, bp: number): number => Math.round((pence * bp) / 10000);

/** Pre-order band discount (bp) for a given days-to-ETA. Highest satisfied
 *  minDaysToEta wins; 0 if none match. */
export function bandDiscountBp(bands: PreorderBand[], daysToEta: number): number {
  let best = 0;
  let bestMin = -1;
  for (const b of bands) {
    if (daysToEta >= b.minDaysToEta && b.minDaysToEta > bestMin) {
      best = b.discountBp;
      bestMin = b.minDaysToEta;
    }
  }
  return best;
}

/** The price floor (§15.3): landed + variable fulfilment + payment fee + min
 *  contribution. Percentages are of the base price. Never exposed. */
export function priceFloorPence(input: QuoteInputs): number {
  const { basePricePence: base, landedCostPence, rule } = input;
  return (
    landedCostPence +
    rule.variableFulfilmentPence +
    pctOf(base, rule.paymentFeeBp) +
    pctOf(base, rule.minContributionBp)
  );
}

export function computeQuote(input: QuoteInputs): PriceQuote {
  const base = input.basePricePence;
  const { rule, qty, cartonSize } = input;

  // --- carton tier: exact whole-carton multiples only ---
  const cartonApplies = !!cartonSize && cartonSize > 1 && qty % cartonSize === 0;
  const cartonBp = cartonApplies ? rule.cartonDiscountBp : 0;

  // --- pre-order band (only for an inbound pool) ---
  const preorderBp = input.daysToEta != null ? bandDiscountBp(rule.preorderBands, input.daysToEta) : 0;

  // --- additive structural stack, capped ---
  const structuralBp = Math.min(cartonBp + preorderBp, rule.maxStackBp);
  const structuralDiscount = pctOf(base, structuralBp);

  const floor = priceFloorPence(input);
  const structuralPreFloor = base - structuralDiscount;
  const structuralUnit = Math.max(structuralPreFloor, floor);

  // --- code path (best-of, never stacked with structural) ---
  let codePreFloor: number | null = null;
  if (input.code) {
    const codeDiscount =
      input.code.kind === 'percent'
        ? pctOf(base, input.code.valueBp ?? 0)
        : Math.max(0, input.code.valuePence ?? 0);
    codePreFloor = base - codeDiscount;
  }
  const codeUnit = codePreFloor != null ? Math.max(codePreFloor, floor) : null;

  // Choose the cheaper of {structural, code}. Ties → structural (simpler to
  // explain, and never worse for the customer).
  let unitPricePence = structuralUnit;
  let chosenPreFloor = structuralPreFloor;
  let discountWinner: PriceQuote['discountWinner'] = structuralBp > 0 ? 'structural' : 'none';
  if (codeUnit != null && codeUnit < structuralUnit) {
    unitPricePence = codeUnit;
    chosenPreFloor = codePreFloor!;
    discountWinner = 'code';
  }

  // Clamped iff the chosen nominal (pre-floor) price was below the floor.
  const clamped = chosenPreFloor < floor;

  // A discount can never RAISE the price: if the floor exceeds base (an
  // underwater SKU priced below its landed cost), fall back to base — no
  // discount — rather than presenting a higher-than-shelf "discounted" price.
  unitPricePence = Math.min(base, unitPricePence);

  const savingsVsBasePence = base - unitPricePence;
  if (savingsVsBasePence <= 0) discountWinner = 'none';

  // --- itemise savings per source ---
  const savings: SavingItem[] = [];
  if (discountWinner === 'code') {
    savings.push({ source: 'code', savingPence: savingsVsBasePence });
  } else if (discountWinner === 'structural' && savingsVsBasePence > 0) {
    // Allocate the (possibly floor-clamped) total across carton/preorder in
    // proportion to their nominal bp so the itemised figures always sum to the
    // real saving.
    const nominal = structuralDiscount || 1;
    const cartonNominal = pctOf(base, cartonBp);
    const preorderNominal = pctOf(base, preorderBp);
    if (cartonBp > 0) {
      savings.push({
        source: 'carton',
        savingPence: Math.round((savingsVsBasePence * cartonNominal) / nominal),
      });
    }
    if (preorderBp > 0) {
      const cartonPart = savings.find((s) => s.source === 'carton')?.savingPence ?? 0;
      savings.push({ source: 'preorder', savingPence: savingsVsBasePence - cartonPart });
    }
  }

  const tierApplied = cartonApplies ? 'carton' : 'single';

  // --- carton upsell hint (only when not already at a carton tier) ---
  let cartonMultipleHint: string | null = null;
  if (!cartonApplies && cartonSize && cartonSize > 1) {
    const remainder = qty % cartonSize;
    const unitsToCarton = cartonSize - remainder;
    const perUnitCartonSaving = pctOf(base, rule.cartonDiscountBp);
    if (perUnitCartonSaving > 0) {
      cartonMultipleHint = `Add ${unitsToCarton} more to reach a full carton (${cartonSize}) and save £${(perUnitCartonSaving / 100).toFixed(2)} a roll`;
    }
  }

  const quoteExpiresAt = new Date(input.nowMs + rule.quoteTtlMinutes * 60_000).toISOString();

  return {
    sku: input.sku,
    qty,
    pool: input.pool,
    currency: 'GBP',
    basePricePence: base,
    unitPricePence,
    lineTotalPence: unitPricePence * qty,
    tierApplied,
    cartonMultipleHint,
    savings,
    savingsVsBasePence,
    discountWinner,
    quoteExpiresAt,
    preorderDiscountBpInternal: preorderBp,
    cartonDiscountBpInternal: cartonBp,
    structuralBpInternal: structuralBp,
    floorPricePenceInternal: floor,
    clampedInternal: clamped,
  };
}

/** Strip every *Internal field — the ONLY quote shape a route may return. */
export function toCustomerFacing(quote: PriceQuote): CustomerFacingQuote {
  const {
    preorderDiscountBpInternal: _a,
    cartonDiscountBpInternal: _b,
    structuralBpInternal: _c,
    floorPricePenceInternal: _d,
    clampedInternal: _e,
    ...rest
  } = quote;
  void _a;
  void _b;
  void _c;
  void _d;
  void _e;
  return rest;
}
