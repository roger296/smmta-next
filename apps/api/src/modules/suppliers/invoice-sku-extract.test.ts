/**
 * The spellings in here are REAL — every one was observed in the captured
 * BumbleBee invoice lines (apps/api/data/invoice-skus/). That is the point:
 * these rules exist to reconcile how suppliers actually type, not how a
 * reasonable supplier would.
 */
import { describe, expect, it } from 'vitest';
import {
  codeCore,
  isJunkSku,
  normalisePack,
  packsAgree,
  unitCost,
  type InvoiceLine,
} from './invoice-sku-extract.js';

const line = (p: Partial<InvoiceLine>): InvoiceLine => ({
  stock_item: null, sku: null, supplier: null, invoice_date: null,
  invoice_number: null, pack_size: null, quantity: null, unit_price: null,
  line_total: null, confidence: null, ...p,
});

describe('codeCore', () => {
  it.each([
    ['33891', '', '33891'],
    ['A33891', 'A', '33891'],
    ['A 33891', 'A', '33891'],
    ['C113654', 'C', '113654'],
    ['C 113654', 'C', '113654'],
    ['F 4111', 'F', '4111'],
  ])('groups %s as prefix %s + digits %s', (sku, prefix, digits) => {
    expect(codeCore(sku)).toEqual({ prefix, digits });
  });

  it('lower-cases nothing but the prefix comparison', () => {
    expect(codeCore('a33891')).toEqual({ prefix: 'A', digits: '33891' });
  });

  /**
   * The load-bearing case. Uncle Roy's `20036PR500` and `20036PR1000` are the
   * same essence in two bottle sizes — two separate things to buy, each with
   * its own price. If these ever grouped, one would become an "alias" of the
   * other and the losing pack size would vanish from the catalogue.
   */
  it.each(['20036PR500', '20036PR1000', '21937PR500', '20153PR1000'])(
    'refuses to group %s, where the letters are in the middle',
    (sku) => {
      expect(codeCore(sku)).toBeNull();
    },
  );

  it('refuses a single digit, which is never a real code', () => {
    expect(codeCore('1')).toBeNull();
  });
});

describe('isJunkSku', () => {
  // Observed: Uncle Roy's website-order lines carry sku "1" — a line number.
  it.each(['1', '11', '000'])('flags %s', (s) => expect(isJunkSku(s)).toBe(true));
  it.each(['301', '33891', '10230'])('keeps %s', (s) => expect(isJunkSku(s)).toBe(false));
});

describe('normalisePack', () => {
  it.each([
    // spacing and case
    [['1 x 1ltr', '1x1ltr', '1X1LTR'], '1l'],
    // an implicit pack of one
    [['1x500g', '500g'], '500g'],
    [['1x250g', '250g'], '250g'],
    [['1 x 2.5kg', '2.5kg'], '2.5kg'],
    // unit words
    [['2x5l', '2x5ltr', '2 x 5ltr'], '2x5l'],
    // "a pack of 10" is one case of 10
    [['10 Pack', '1x10', '1 x 10'], '10'],
    [['5 Pack', '1x5'], '5'],
    // a single loose item, four ways
    [['1xEach', '1x1', '1 x 1', 'Each'], 'each'],
    // a genuine case size survives
    [['40 x 250g', '40x250g'], '40x250g'],
    [['12 x 1ltr', '12x1ltr'], '12x1l'],
  ])('reads %j as one pack', (spellings, expected) => {
    for (const s of spellings as string[]) expect(normalisePack(s)).toBe(expected);
  });

  it('abstains on nothing rather than inventing a pack', () => {
    expect(normalisePack(null)).toBe('');
    expect(normalisePack('')).toBe('');
  });
});

describe('packsAgree', () => {
  it('folds the spelling differences that flooded the first review file', () => {
    expect(packsAgree(['1x500g', '500g'])).toBe(true);
    expect(packsAgree(['2x5l', '2x5ltr'])).toBe(true);
    expect(packsAgree(['10 Pack', '1x10'])).toBe(true);
  });

  /**
   * A case of 40 and a single tub are NOT the same buying decision — Brakes
   * `11127` is billed as `40 x 250g`, and a line that says `250g` is the OCR
   * dropping the case count. Ordering 1 of the wrong one is a 40x error.
   */
  it('still clashes on a real difference', () => {
    expect(packsAgree(['40 x 250g', '250g'])).toBe(false);
    expect(packsAgree(['1 x 1ltr', '12 x 1ltr'])).toBe(false);
  });

  it('treats a missing pack as no opinion, not a clash', () => {
    expect(packsAgree(['1x1kg', null, ''])).toBe(true);
    expect(packsAgree([null, null])).toBe(true);
  });
});

describe('unitCost', () => {
  it('uses unit_price when the OCR read one', () => {
    expect(unitCost(line({ unit_price: 1.67, line_total: 5.01, quantity: 3 })))
      .toEqual({ cost: 1.67, disagreed: false });
  });

  it('derives from the line total when unit_price is absent — the common case', () => {
    // Brakes C19665, 12 x 1ltr: line_total 14.55 on quantity 1.
    expect(unitCost(line({ unit_price: null, line_total: 14.55, quantity: 1 })))
      .toEqual({ cost: 14.55, disagreed: false });
  });

  /**
   * The defect this rule exists for: the OCR reads the LINE TOTAL into the
   * unit-price column. 32.94 against a real 11.12 on a quantity of 3 would put
   * a cost 3x over onto a purchase order, and nothing downstream questions it.
   */
  it('prefers the derived figure when the two disagree, and says so', () => {
    expect(unitCost(line({ unit_price: 32.94, line_total: 33.36, quantity: 3 })))
      .toEqual({ cost: 11.12, disagreed: true });
  });

  it('tolerates a penny of rounding without calling it a disagreement', () => {
    const r = unitCost(line({ unit_price: 3.33, line_total: 10.0, quantity: 3 }));
    expect(r.disagreed).toBe(false);
    expect(r.cost).toBe(3.33);
  });

  it('returns no cost rather than dividing by a missing quantity', () => {
    expect(unitCost(line({ line_total: 12.0, quantity: 0 })).cost).toBeNull();
    expect(unitCost(line({ line_total: 12.0, quantity: null })).cost).toBeNull();
    expect(unitCost(line({})).cost).toBeNull();
  });

  it('ignores a zero unit_price, which means "not read" not "free"', () => {
    expect(unitCost(line({ unit_price: 0, line_total: 20.15, quantity: 1 })).cost).toBe(20.15);
  });
});
