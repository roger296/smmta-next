/**
 * The importer's pure parts: reading the extract CSV, and how a product name is
 * compared. Both are places where being loose loses data silently.
 */
import { describe, expect, it } from 'vitest';
import { normaliseName, readSkuCsv } from './import-invoice-skus.js';

describe('readSkuCsv', () => {
  const csv = [
    'supplier,supplier_sku,aliases,description,pack_size,unit_cost_gbp,lines_seen,last_seen,min_confidence',
    'Brakes,33891,"A 33891, A33891",Sysco Classic Self Raising Flour,1 x 25kg,25.4,10,2026-04-08,0.90',
    'Brakes,11127,"C 11127, C11127",Wholesome Farms Unsalted Butter,40x250g,58.51,158,2026-09-11,0.70',
    'Makro,900123,,Caster Sugar,1x25kg,,3,2026-08-01,0.95',
  ].join('\n');

  it('reads the row the whole feature exists for', () => {
    const [flour] = readSkuCsv(csv);
    expect(flour).toEqual({
      supplier: 'Brakes',
      supplierSku: '33891',
      aliases: ['A 33891', 'A33891'],
      description: 'Sysco Classic Self Raising Flour',
      packSize: '1 x 25kg',
      unitCostGbp: '25.4',
      linesSeen: 10,
      lastSeen: '2026-04-08',
    });
  });

  /**
   * Commas ONLY. "A 33891" is a real Brakes code with a space in it; splitting
   * on whitespace would turn one real code into two invented ones, and both
   * would then fail to resolve against a future invoice.
   */
  it('splits aliases on commas, never on the space inside a code', () => {
    expect(readSkuCsv(csv)[0]!.aliases).toEqual(['A 33891', 'A33891']);
  });

  it('reads an empty alias cell as no aliases, not as one blank one', () => {
    expect(readSkuCsv(csv)[2]!.aliases).toEqual([]);
  });

  /**
   * An empty cost is NOT zero. `cost_gbp` was made nullable (migration 0051)
   * precisely because 0.00 on a purchase order line is a GBP0 order, whereas
   * "we do not know yet" is a blank the reorder engine falls back from.
   */
  it('reads a blank cost as unknown rather than as zero', () => {
    expect(readSkuCsv(csv)[2]!.unitCostGbp).toBeNull();
  });

  it('survives a UTF-8 BOM, which is what Excel writes', () => {
    expect(readSkuCsv(`﻿${csv}`)[0]!.supplierSku).toBe('33891');
  });
});

describe('normaliseName', () => {
  it('ignores case, punctuation and whitespace runs', () => {
    expect(normaliseName('Butter,  Unsalted (2kg)')).toBe(normaliseName('butter unsalted 2kg'));
    expect(normaliseName('Tate & Lyle Icing Sugar')).toBe('tate lyle icing sugar');
  });

  /**
   * It must NOT ignore the words themselves. A supplier describes goods its own
   * way ("Wholesome Farms Unsalted Butter") and the venue counts them another
   * ("Butter, unsalted") - those are a job for a human, not for a normaliser
   * quietly deciding they are the same product and welding a price to it.
   */
  it('does not make different products look the same', () => {
    expect(normaliseName('Unsalted Butter')).not.toBe(normaliseName('Salted Butter'));
    expect(normaliseName('Wholesome Farms Unsalted Butter')).not.toBe(normaliseName('Butter, unsalted'));
    expect(normaliseName('Icing Sugar')).not.toBe(normaliseName('Caster Sugar'));
  });

  it('is empty for a name made only of punctuation, so it matches nothing', () => {
    expect(normaliseName('---')).toBe('');
  });
});
