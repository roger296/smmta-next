/**
 * Count bucketing is OPT-IN (Aug-2026 feedback set, defect D-2).
 *
 * `bucketCount` used to default `quantum = 100`, silently rounding every
 * non-discrete count to the nearest 100 *stock units*. A 4 kg count of icing
 * sugar submitted as **0**; a 250 g count as 300. On approval the ledger is
 * trued up to the destroyed figure, so the loss is permanent and invisible.
 *
 * Every test here asserts the same principle from a different angle: nothing
 * is rounded unless a quantum was configured for that product, in that
 * product's own stock unit.
 */
import { describe, expect, it } from 'vitest';
import { bucketCount, bucketNote, isDiscreteUom, purchaseToStock } from './uom';

describe('bucketCount — no bucketing without an explicit quantum (D-2)', () => {
  it('D-2: a 4 kg count stays 4', () => {
    // The exact figure from the 12 Aug session. Under the old default this
    // was Math.round(4 / 100) * 100 === 0.
    expect(bucketCount(4, 'kg')).toBe(4);
  });

  it('D-2: a 250 g count stays 250', () => {
    // Under the old default this became 300.
    expect(bucketCount(250, 'g')).toBe(250);
  });

  it('leaves discrete units alone', () => {
    expect(bucketCount(4, 'each')).toBe(4);
  });

  it('keeps a part-unit intact', () => {
    expect(bucketCount(0.5, 'kg')).toBe(0.5);
  });

  it('buckets ONLY when a quantum is passed explicitly', () => {
    expect(bucketCount(250, 'g', 100)).toBe(300);
    expect(bucketCount(1234, 'g', 100)).toBe(1200);
  });

  it.each([undefined, null, 0, -100])('treats %s as "do not bucket"', (quantum) => {
    expect(bucketCount(4, 'kg', quantum as number | null | undefined)).toBe(4);
  });

  it('never buckets a discrete unit even when a quantum is configured', () => {
    // A "quantum" on an `each` product is a data-entry mistake, not an
    // instruction to round someone's count of 7 boxes to 0.
    expect(bucketCount(7, 'each', 100)).toBe(7);
  });
});

describe('bucketNote', () => {
  it('describes an active quantum so the counter can see what happened', () => {
    expect(bucketNote(100, 'g')).toBe('rounded to nearest 100 g');
  });

  it('says nothing when nothing is being rounded', () => {
    expect(bucketNote(null, 'g')).toBeNull();
    expect(bucketNote(0, 'g')).toBeNull();
    expect(bucketNote(100, 'each')).toBeNull();
  });
});

describe('other uom helpers', () => {
  it('converts purchase to stock units', () => {
    expect(purchaseToStock(5, 1000)).toBe(5000);
    // 4 × 25 kg sack of icing sugar, in grams.
    expect(purchaseToStock(4, 25000)).toBe(100000);
  });

  it('knows the discrete units', () => {
    expect(isDiscreteUom('each')).toBe(true);
    expect(isDiscreteUom(' EA ')).toBe(true);
    expect(isDiscreteUom('g')).toBe(false);
  });
});
