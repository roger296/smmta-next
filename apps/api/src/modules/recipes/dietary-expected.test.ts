/**
 * The arithmetic behind a mixed-diet session.
 *
 * Every table bakes the cake, so the base recipe applies to ALL of them. A
 * gluten-free or vegan table then deviates: some base ingredients come out,
 * substitutes go in. Get this wrong in either direction and nothing errors —
 * the bake form simply expects the wrong amount, the variance looks like the
 * baker's fault, and the materials cost is quietly off.
 *
 * These pin the shape of that calculation without needing a database.
 */
import { describe, expect, it } from 'vitest';

/** The rule, extracted so it can be reasoned about on its own. */
function expectedFor(
  base: Record<string, number>,
  opts: {
    totalTables: number;
    gfTables?: number;
    veganTables?: number;
    gfRemove?: string[];
    veganRemove?: string[];
    gfAdd?: Record<string, number>;
    veganAdd?: Record<string, number>;
  },
): Record<string, number> {
  const gf = opts.gfTables ?? 0;
  const vg = opts.veganTables ?? 0;
  const out: Record<string, number> = {};
  for (const [p, perTable] of Object.entries(base)) out[p] = perTable * opts.totalTables;
  for (const p of opts.gfRemove ?? []) if (out[p] != null) out[p] -= base[p]! * gf;
  for (const p of opts.veganRemove ?? []) if (out[p] != null) out[p] -= base[p]! * vg;
  for (const [p, q] of Object.entries(opts.gfAdd ?? {})) out[p] = (out[p] ?? 0) + q * gf;
  for (const [p, q] of Object.entries(opts.veganAdd ?? {})) out[p] = (out[p] ?? 0) + q * vg;
  for (const k of Object.keys(out)) out[k] = Math.max(0, Math.round(out[k]! * 10000) / 10000);
  return out;
}

const BASE = { flour: 0.25, butter: 0.1, eggs: 4 };

describe('expected consumption across dietary variants', () => {
  it('applies the base recipe to EVERY table, not just the regular ones', () => {
    // 8 regular + 1 GF + 1 vegan = 10 tables, all baking a cake.
    const out = expectedFor(BASE, { totalTables: 10 });
    expect(out.flour).toBe(2.5);
    expect(out.eggs).toBe(40);
  });

  it('reduces a removed ingredient by that diet\'s share only', () => {
    const out = expectedFor(BASE, {
      totalTables: 10,
      gfTables: 2,
      gfRemove: ['flour'],
    });
    // 10 tables of flour, less the 2 gluten-free ones.
    expect(out.flour).toBe(0.25 * 8);
    // Untouched ingredients are unaffected.
    expect(out.butter).toBe(1);
  });

  it('adds the substitute for that diet\'s tables', () => {
    const out = expectedFor(BASE, {
      totalTables: 10,
      gfTables: 2,
      gfRemove: ['flour'],
      gfAdd: { 'gf-flour': 0.3 },
    });
    expect(out['gf-flour']).toBe(0.6);
  });

  it('MERGES a substitute that is already in the base recipe', () => {
    // Vegan tables swap butter for more oil, and the recipe already uses oil.
    const out = expectedFor(
      { ...BASE, oil: 0.05 },
      { totalTables: 10, veganTables: 3, veganRemove: ['butter'], veganAdd: { oil: 0.08 } },
    );
    // 10 tables of base oil PLUS 3 tables of the vegan extra — one line, not
    // two, or the baker would be asked to count oil twice.
    // 0.5 from the base plus 0.24 from the vegan extra.
    expect(out.oil).toBeCloseTo(0.74, 10);
    // toBeCloseTo throughout: 0.1 * 7 is 0.7000000000000001 in IEEE754 while
    // the service rounds to 4dp. The rounding is right; the raw expression is
    // what cannot be compared exactly.
    expect(out.butter).toBeCloseTo(0.7, 10);
  });

  it('handles both diets at once without double-counting', () => {
    const out = expectedFor(BASE, {
      totalTables: 10,
      gfTables: 2,
      veganTables: 3,
      gfRemove: ['flour'],
      veganRemove: ['butter', 'eggs'],
      gfAdd: { 'gf-flour': 0.3 },
      veganAdd: { 'oat-milk': 0.2 },
    });
    expect(out.flour).toBeCloseTo(2, 10);
    expect(out.butter).toBeCloseTo(0.7, 10);
    expect(out.eggs).toBe(28);
    expect(out['gf-flour']).toBeCloseTo(0.6, 10);
    expect(out['oat-milk']).toBeCloseTo(0.6, 10);
  });

  it('never goes negative when every table is on that diet', () => {
    // All 4 tables gluten-free: the flour drops out entirely, and must read
    // as 0 rather than a negative expectation.
    const out = expectedFor(BASE, { totalTables: 4, gfTables: 4, gfRemove: ['flour'] });
    expect(out.flour).toBe(0);
  });

  it('ignores a removal naming something the recipe never had', () => {
    // A recipe-authoring mistake must not push another ingredient negative.
    const out = expectedFor(BASE, { totalTables: 5, gfTables: 5, gfRemove: ['marzipan'] });
    expect(out.flour).toBe(1.25);
    expect(out.marzipan).toBeUndefined();
  });
});
