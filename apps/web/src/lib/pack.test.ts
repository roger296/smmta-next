/**
 * Reading a purchase quantity back to a human (Aug-2026, C-1/C-2/C-4/C-6).
 *
 * "Icing sugar displayed an incorrect default unit quantity of 1kg."
 * "Skittles displayed an incorrect base unit, preventing the 1.6kg bags from
 *  being added."
 *
 * Goods In printed the raw stock figure in the raw stock unit with no purchase
 * model behind it, so a 25 kg sack read `= 1 g · £0.00/unit`.
 */
import { describe, expect, it } from 'vitest';
import {
  costPerStockUnit,
  describePackLine,
  formatMoney,
  formatStockQty,
  needsPurchaseUnit,
  packFactor,
  packLabel,
  packStepLabel,
} from './pack';

const ICING = {
  stockUom: 'g',
  purchaseUom: 'sack',
  purchaseToStockFactor: '25000',
  packDescription: '25 kg sack',
};

const SKITTLES = {
  stockUom: 'g',
  purchaseUom: 'bag',
  purchaseToStockFactor: '1600',
  packDescription: '1.6 kg bag',
};

/** The 12 Aug seed shape: grams, no purchase unit, factor 1. */
const UNCONFIGURED = {
  stockUom: 'g',
  purchaseUom: null,
  purchaseToStockFactor: '1',
  packDescription: null,
};

describe('describePackLine (C-1/C-2)', () => {
  it('C-1 REGRESSION: reads "4 × 25 kg sack = 100 kg", not "= 1 g"', () => {
    expect(describePackLine(4, ICING)).toBe('4 × 25 kg sack = 100 kg');
  });

  it('C-2 REGRESSION: the 1.6 kg Skittles bag reads correctly', () => {
    expect(describePackLine(4, SKITTLES)).toBe('4 × 1.6 kg bag = 6.4 kg');
    expect(describePackLine(1, SKITTLES)).toBe('1 × 1.6 kg bag = 1.6 kg');
  });

  it('C-1: refuses to complete the phrase with no purchase unit', () => {
    // Printing "= 4 g" here is precisely the 12 Aug lie. There is no honest
    // resolved figure, so none is offered.
    expect(describePackLine(4, UNCONFIGURED)).toBe('4 — no purchase unit set');
  });

  it('falls back to the bare purchase unit when there is no pack description', () => {
    expect(
      describePackLine(2, { stockUom: 'ml', purchaseUom: 'drum', purchaseToStockFactor: '20000' }),
    ).toBe('2 × drum = 40 L');
  });
});

describe('formatStockQty — display only', () => {
  it('scales g to kg past 1000', () => {
    expect(formatStockQty(100000, 'g')).toBe('100 kg');
    expect(formatStockQty(1600, 'g')).toBe('1.6 kg');
  });

  it('leaves a sub-kilo figure in grams — a 250 g count is said in grams', () => {
    expect(formatStockQty(250, 'g')).toBe('250 g');
    expect(formatStockQty(999, 'g')).toBe('999 g');
  });

  it('scales ml to L', () => {
    expect(formatStockQty(20000, 'ml')).toBe('20 L');
  });

  it('leaves an unrecognised unit alone', () => {
    expect(formatStockQty(7, 'each')).toBe('7 each');
    expect(formatStockQty(4, 'kg')).toBe('4 kg');
  });

  it('does not leave trailing zeroes', () => {
    expect(formatStockQty(2000, 'g')).toBe('2 kg');
  });
});

describe('formatMoney (C-4)', () => {
  it('C-4: a sub-penny price is NOT rounded to £0.00', () => {
    // This is the tester's "£0.00" in one assertion.
    expect(formatMoney(0.0012)).toBe('£0.0012');
  });

  it('shows ordinary amounts at 2dp', () => {
    expect(formatMoney(30)).toBe('£30.00');
    expect(formatMoney(4.5)).toBe('£4.50');
  });

  it('shows a genuine zero as £0.00', () => {
    expect(formatMoney(0)).toBe('£0.00');
  });
});

describe('costPerStockUnit', () => {
  it('divides the pack price by the factor', () => {
    // £30 a sack, 25000 g a sack → £0.0012/g.
    expect(costPerStockUnit(30, ICING)).toBeCloseTo(0.0012, 6);
  });

  it('is the price itself when the factor is 1', () => {
    expect(costPerStockUnit(0.0012, UNCONFIGURED)).toBeCloseTo(0.0012, 6);
  });
});

describe('needsPurchaseUnit (the blocked-line guard, C-1)', () => {
  it('blocks a fungible product with no purchase unit', () => {
    expect(needsPurchaseUnit(UNCONFIGURED)).toBe(true);
  });

  it('does not block a configured product', () => {
    expect(needsPurchaseUnit(ICING)).toBe(false);
  });

  it('does not block a DISCRETE product — "each" needs no purchase unit', () => {
    expect(
      needsPurchaseUnit({ stockUom: 'each', purchaseUom: null, purchaseToStockFactor: '1' }),
    ).toBe(false);
  });
});

describe('packStepLabel (C-6)', () => {
  it('names the pack on the button — "+1 sack", not "+1"', () => {
    expect(packStepLabel(ICING, '+')).toBe('+1 sack');
    expect(packStepLabel(ICING, '−')).toBe('−1 sack');
  });

  it('falls back to "pack" when there is no purchase unit', () => {
    expect(packStepLabel(UNCONFIGURED, '+')).toBe('+1 pack');
  });
});

describe('packLabel / packFactor', () => {
  it('prefers the pack description over the bare unit', () => {
    expect(packLabel(ICING)).toBe('25 kg sack');
    expect(packLabel({ ...ICING, packDescription: null })).toBe('sack');
    expect(packLabel(UNCONFIGURED)).toBeNull();
  });

  it('treats a zero or missing factor as 1 rather than dividing by it', () => {
    expect(packFactor({ stockUom: 'g', purchaseUom: 'x', purchaseToStockFactor: '0' })).toBe(1);
    expect(packFactor({ stockUom: 'g', purchaseUom: 'x', purchaseToStockFactor: null })).toBe(1);
  });
});
