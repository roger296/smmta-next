/**
 * Unit tests for the category mapping rules + evaluator.
 *
 * Two layers:
 *
 *   1. Property tests against the canonical RULES — every rule's
 *      `assignTo` resolves to a real taxonomy entry (already checked
 *      at module-load by validateRules, this test catches it in CI
 *      too).
 *
 *   2. Scenario tests — given a representative product fact-set,
 *      assert which category slug-path the rules pick. These are
 *      the contract for the rule set: if you change a rule, the
 *      relevant scenario test should change with it.
 */
import { describe, expect, it } from 'vitest';
import { evaluateRules, RULES } from './category-mapping.js';
import { TAXONOMY, findTaxonomyEntry } from './taxonomy.js';

describe('RULES validation', () => {
  it('every rule assigns to a real taxonomy slug path', () => {
    for (const r of RULES) {
      expect(findTaxonomyEntry(r.assignTo)).not.toBeNull();
    }
  });

  it('has at least one rule covering each top-tier (except uncategorised)', () => {
    const covered = new Set<string>();
    for (const r of RULES) {
      const top = r.assignTo.split('/')[0];
      if (top) covered.add(top);
    }
    for (const top of TAXONOMY) {
      if (top.slug === 'uncategorised') continue;
      expect(covered).toContain(top.slug);
    }
  });
});

describe('evaluateRules — hi-vis routing', () => {
  it('routes a hi-vis t-shirt to workwear hi-vis tops', () => {
    expect(
      evaluateRules({
        source: 'ralawise',
        productType: 'T-Shirt',
        name: 'Result Safe-Guard Hi-Vis T-Shirt',
      }),
    ).toBe('workwear-and-safety/hi-vis-tops-and-vests');
  });

  it('routes a hi-vis vest to workwear hi-vis tops', () => {
    expect(
      evaluateRules({
        source: 'ralawise',
        productType: 'Vest',
        name: 'High Visibility Vest',
      }),
    ).toBe('workwear-and-safety/hi-vis-tops-and-vests');
  });

  it('routes a hi-vis JACKET to workwear hi-vis outerwear (not tops)', () => {
    // The brief's example: hi-vis jacket lives in hi-vis outerwear,
    // not the generic jackets-and-coats bucket.
    expect(
      evaluateRules({
        source: 'ralawise',
        productType: 'Jacket',
        name: 'Hi-Vis Bomber Jacket',
      }),
    ).toBe('workwear-and-safety/hi-vis-outerwear');
  });

  it('routes hi-vis softshell to hi-vis outerwear', () => {
    expect(
      evaluateRules({
        source: 'ralawise',
        productType: 'Softshell',
        name: 'Yoko Hi-Vis Softshell Jacket',
      }),
    ).toBe('workwear-and-safety/hi-vis-outerwear');
  });
});

describe('evaluateRules — kids', () => {
  it('routes a kids hoodie to kids tops (not tops/hoodies)', () => {
    expect(
      evaluateRules({
        source: 'ralawise',
        productType: 'Hoodie',
        name: "Kids' Pull-Over Hoodie",
      }),
    ).toBe('kids-and-schoolwear/kids-tops');
  });

  it('routes a baby t-shirt to baby-and-toddler', () => {
    expect(
      evaluateRules({
        source: 'ralawise',
        productType: 'T-Shirt',
        name: 'Baby Organic Cotton Tee',
      }),
    ).toBe('kids-and-schoolwear/baby-and-toddler');
  });

  it('routes school sports kit to school-sports-kit', () => {
    expect(
      evaluateRules({
        source: 'ralawise',
        productType: 'Polo',
        name: "Kids' Rugby PE Kit Polo",
      }),
    ).toBe('kids-and-schoolwear/school-sports-kit');
  });

  it('routes a kids trouser to kids bottoms', () => {
    expect(
      evaluateRules({
        source: 'ralawise',
        productType: 'Trouser',
        name: "Kids' School Trouser",
      }),
    ).toBe('kids-and-schoolwear/kids-bottoms');
  });
});

describe('evaluateRules — outerwear by type', () => {
  it('bodywarmer → gilets and bodywarmers', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Bodywarmer', name: 'Solitude Bodywarmer' }),
    ).toBe('outerwear/gilets-and-bodywarmers');
  });
  it('fleece → fleeces', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Fleece', name: 'Active Fleece' }),
    ).toBe('outerwear/fleeces');
  });
  it('softshell → softshells', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Softshell', name: 'Active Softshell' }),
    ).toBe('outerwear/softshells');
  });
  it('waterproof → waterproofs', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Waterproof', name: 'Rain Jacket' }),
    ).toBe('outerwear/waterproofs');
  });
  it('plain jacket → jackets-and-coats', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Jacket', name: 'Padded Jacket' }),
    ).toBe('outerwear/jackets-and-coats');
  });
});

describe('evaluateRules — tops by garment type', () => {
  it('polo → polo-shirts', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Polo', name: 'Classic Pique Polo' }),
    ).toBe('tops/polo-shirts');
  });
  it('t-shirt → t-shirts', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'T-Shirt', name: 'Heavyweight T-Shirt' }),
    ).toBe('tops/t-shirts');
  });
  it('hoodie → hoodies (and NOT sweatshirts, since hoodie rule comes first)', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Hoodie', name: 'Heavy Blend Hooded Sweatshirt' }),
    ).toBe('tops/hoodies');
  });
  it('sweatshirt → sweatshirts', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Sweatshirt', name: 'Crewneck Sweatshirt' }),
    ).toBe('tops/sweatshirts');
  });
  it('plain shirt → shirts', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Shirt', name: 'Oxford Long-Sleeve Shirt' }),
    ).toBe('tops/shirts');
  });
});

describe('evaluateRules — bottoms', () => {
  it('jogger → joggers', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Joggers', name: 'Premium Joggers' }),
    ).toBe('bottoms/joggers');
  });
  it('legging → leggings', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Legging', name: 'Cropped Leggings' }),
    ).toBe('bottoms/leggings');
  });
  it('cargo trouser → workwear/work-trousers (workwear takes priority)', () => {
    expect(
      evaluateRules({
        source: 'ralawise',
        productType: 'Cargo Trouser',
        categorisation: 'Cargo Trouser',
        name: 'Action Cargo Trouser',
      }),
    ).toBe('workwear-and-safety/work-trousers');
  });
  it('plain trouser → bottoms/trousers', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Trouser', name: 'Slim-fit Trouser' }),
    ).toBe('bottoms/trousers');
  });
});

describe('evaluateRules — accessories', () => {
  it('rucksack → rucksacks-and-holdalls', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Rucksack', name: 'Heavyweight Rucksack' }),
    ).toBe('bags-and-accessories/rucksacks-and-holdalls');
  });
  it('cap → headwear', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Cap', name: 'Promo Snapback Cap' }),
    ).toBe('bags-and-accessories/headwear');
  });
  it('scarf → gloves-and-scarves', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Scarf', name: 'Woollen Scarf' }),
    ).toBe('bags-and-accessories/gloves-and-scarves');
  });
  it('apron → workwear/aprons-and-tabards', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Apron', name: 'Bib Apron with Pocket' }),
    ).toBe('workwear-and-safety/aprons-and-tabards');
  });
});

describe('evaluateRules — falls through to null when no rule matches', () => {
  it('returns null for fully empty facts', () => {
    expect(evaluateRules({ source: 'ralawise' })).toBeNull();
  });
  it('returns null for an unrecognised garment type with no other signals', () => {
    expect(
      evaluateRules({ source: 'ralawise', productType: 'Mystery Item', name: 'Mystery Item' }),
    ).toBeNull();
  });
});
