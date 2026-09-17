/**
 * The matching rules, tuned against the real 561-product catalogue and the real
 * invoice descriptions. Every fixture below is something that actually appears
 * in one or the other.
 */
import { describe, expect, it } from 'vitest';
import {
  coverage, normaliseName, proposeMatch, significantTokens, type CatalogueProduct,
} from './invoice-sku-match.js';

const p = (name: string, stockCode = 'CODE'): CatalogueProduct => ({ id: name, stockCode, name });

describe('normaliseName', () => {
  it('ignores case and punctuation', () => {
    expect(normaliseName('Tate & Lyle Icing Sugar')).toBe('tate lyle icing sugar');
  });
});

describe('significantTokens', () => {
  it('drops supplier house brands, which name the seller not the goods', () => {
    expect([...significantTokens('Sysco Classic Cornflour')]).toEqual(['cornflour']);
  });

  it('drops bare numbers - a 1400w says nothing about what a thing is', () => {
    expect(significantTokens('Pressure Washer 1400W').has('1400w')).toBe(false);
  });
});

describe('coverage', () => {
  it('measures against the DESCRIPTION, since every candidate covers itself', () => {
    expect(coverage('Cornflour', 'Sysco Classic Cornflour')).toBe(1);
    expect(coverage('Yellow', 'Vytronix Powerful Electric Pressure Washer Jet Wash Patio'))
      .toBeLessThan(0.3);
  });

  /** A partial overlap is a DIFFERENT product, not a weaker match. */
  it('is zero when the candidate does not fit entirely', () => {
    expect(coverage('Unsalted Butter', 'Salted Butter')).toBe(0);
  });
});

describe('singularisation', () => {
  /**
   * The catalogue says "Egg Whites", the invoice says "Noble Free Range Liquid
   * Egg White" — 123 invoice lines, the second-busiest code in the set, and a
   * trailing `s` was the only thing between them.
   */
  it('meets a plural catalogue name with a singular description', () => {
    expect(coverage('Egg Whites', 'Noble Free Range Liquid Egg White')).toBeGreaterThan(0.3);
  });

  /**
   * The invariant is CONSISTENCY, not linguistics. Both the catalogue name and
   * the invoice description go through this, so a stem only has to be the same
   * on both sides — `molasses` landing on `molass` costs nothing. What costs
   * something is two forms of one word landing apart.
   */
  it.each([
    ['Egg Whites', 'Egg White'],
    ['Olives', 'Olive'],
    ['Tomatoes', 'Tomato'],
    ['Boxes', 'Box'],
    ['Dishes', 'Dish'],
    ['Gloves', 'Glove'],
  ])('lands %s and %s on the same token', (plural, single) => {
    expect([...significantTokens(plural)]).toEqual([...significantTokens(single)]);
  });

  it('leaves a word whose s is part of it alone', () => {
    expect(significantTokens('Glass').has('glass')).toBe(true);
  });
});

describe('colour-only candidates', () => {
  /**
   * The catalogue carries colouring products literally named "White" and
   * "Yellow". A colour is a MODIFIER in a supplier's description, so a
   * candidate that is nothing but a colour matches the modifier and means
   * nothing — "Grapes White Seedless" is not a tub of white colouring.
   */
  it.each([
    ['White', 'Grapes White Seedless'],
    ['White', 'SUGAR PASTE-M&B-WHITE'],
    ['Yellow', 'Vytronix Pressure Washer Yellow'],
  ])('never proposes %s for %s', (name, description) => {
    expect(proposeMatch(description, 'X', [p(name)]).candidates).toHaveLength(0);
  });

  /** Narrow on purpose: a colour inside a real name is not the problem. */
  it('still proposes a name that merely contains a colour', () => {
    const r = proposeMatch('Large Blue Vinyl Gloves Powder Free', 'X', [p('Blue Vinyl Gloves - Large')]);
    expect(r.candidates[0]?.product.name).toBe('Blue Vinyl Gloves - Large');
  });

  it('does not take the genuinely useful short names with it', () => {
    for (const [name, desc] of [
      ['Cornflour', 'Sysco Classic Cornflour'],
      ['Basil', 'Herb Bunched Basil'],
      ['Cucumber', 'Cucumber Single BB'],
    ] as const) {
      expect(proposeMatch(desc, 'X', [p(name)]).candidates[0]?.product.name).toBe(name);
    }
  });
});

describe('proposeMatch', () => {
  it('takes a stock-code hit as certain, with no candidates to review', () => {
    const r = proposeMatch('anything at all', 'DAIR-UNSL-BUTR', [p('Unsalted Butter', 'DAIR-UNSL-BUTR')]);
    expect(r.certain?.stockCode).toBe('DAIR-UNSL-BUTR');
    expect(r.candidates).toHaveLength(0);
  });

  it('takes an exact name as certain', () => {
    expect(proposeMatch('Unsalted Butter', 'X', [p('Unsalted Butter')]).certain).toBeTruthy();
  });

  /** A name shared by two live products identifies NEITHER. */
  it('refuses an exact name that two products share', () => {
    const r = proposeMatch('Unsalted Butter', 'X', [p('Unsalted Butter', 'A'), p('Unsalted Butter', 'B')]);
    expect(r.certain).toBeNull();
  });

  it('offers the more specific name first', () => {
    const r = proposeMatch('Brakes The Juice Orange', 'X', [p('Orange', 'A'), p('Orange Juice', 'B')]);
    expect(r.candidates[0]?.product.name).toBe('Orange Juice');
  });

  it('caps the list at three, since a fourth guess is not a proposal', () => {
    const cat = ['Cherry Tomatoes', 'Tomatoes', 'Red Cherry Tomatoes', 'Cherry', 'Red Tomatoes']
      .map((n, i) => p(n, `C${i}`));
    expect(proposeMatch('Red Cherry Tomatoes Punnet', 'X', cat).candidates.length).toBeLessThanOrEqual(3);
  });

  it('returns nothing for goods the catalogue simply does not have', () => {
    const r = proposeMatch('Vytronix Powerful Electric Pressure Washer 1400W', 'X', [
      p('Unsalted Butter'), p('Caster Sugar'),
    ]);
    expect(r.certain).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });
});
