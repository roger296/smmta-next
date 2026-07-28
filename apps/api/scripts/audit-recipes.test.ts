/**
 * The audit exists to catch two things, and the second is the dangerous one.
 *
 * A recipe line pointing at a deleted product simply expects nothing — bad,
 * but visible. A line RE-POINTED at a live product without converting its unit
 * is far worse: the June demo products were in grams, the real catalogue is in
 * kilograms, so "250" silently becomes 250 kg of flour per guest. That is a
 * legal number. Nothing rejects it. It surfaces as an absurd materials cost
 * and a reorder proposal nobody can explain.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../src/config/database.js';
import { auditRecipes } from './audit-recipes.js';

describe('auditRecipes', () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it('returns only recipes that need attention', async () => {
    const results = await auditRecipes();
    expect(Array.isArray(results)).toBe(true);
    // A clean recipe must not appear at all — the report is a to-do list, not
    // an inventory.
    for (const r of results) {
      expect(r.orphanedLines.length + r.unitMismatches.length).toBeGreaterThan(0);
    }
  });

  it('never counts more orphans than the recipe has lines', async () => {
    for (const r of await auditRecipes()) {
      expect(r.orphanedLines.length).toBeLessThanOrEqual(r.totalLines);
    }
  });

  it('suggests the converted quantity when the units are a known scale', async () => {
    for (const r of await auditRecipes()) {
      for (const m of r.unitMismatches) {
        if (m.lineUom === 'g' && m.productUom === 'kg') {
          // The whole point: 250 g must be offered as 0.25 kg, not left as 250.
          expect(Number(m.suggested)).toBeCloseTo(Number(m.qtyPerCover) / 1000, 9);
        }
      }
    }
  });
});
