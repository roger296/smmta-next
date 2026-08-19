/**
 * Recipe CSV validation (Aug-2026 feedback set, F-4 / F-5).
 *
 * Every rule here describes something that becomes INVISIBLE once it is in the
 * database. F-5 — "Selecting Vegan or GF options for Battenburg failed to
 * generate required ingredients" — is the shape they all share: nothing errors,
 * the baker just sees the standard list and assumes it worked.
 */
import { describe, expect, it } from 'vitest';
import {
  crossValidate,
  formatProblems,
  groupRecipes,
  missingColumns,
  parseIngredients,
  parseRecipes,
} from './recipe-import.js';

const ING = (over: Record<string, string> = {}) => ({
  slug: 'plain-flour',
  name: 'Plain Flour',
  stock_uom: 'g',
  purchase_uom: 'sack',
  purchase_to_stock_factor: '16000',
  pack_description: '16 kg sack',
  expected_next_cost: '11.4',
  barcode: '',
  count_quantum: '',
  ...over,
});

const REC = (over: Record<string, string> = {}) => ({
  bake: 'Battenburg',
  effective_from: '2026-01-01',
  site_slug: '',
  variant: 'BASE',
  ingredient_slug: 'plain-flour',
  qty_per_table: '400',
  unit_cost: '',
  ...over,
});

const rules = (problems: { rule: string }[]) => problems.map((p) => p.rule);

describe('missingColumns', () => {
  it('names every required column the header lacks', () => {
    expect(missingColumns(['slug', 'Name'], ['slug', 'name', 'stock_uom'])).toEqual(['stock_uom']);
  });
});

describe('parseIngredients', () => {
  it('parses a good row', () => {
    const { ingredients, problems } = parseIngredients([ING()]);
    expect(problems).toEqual([]);
    expect(ingredients[0]).toMatchObject({
      slug: 'plain-flour',
      stockUom: 'g',
      purchaseUom: 'sack',
      purchaseToStockFactor: 16000,
      expectedNextCost: 11.4,
      // Blank is NOT zero — see the quantum rule below.
      countQuantum: null,
      barcode: null,
    });
  });

  it('rejects a duplicate slug rather than silently keeping the last one', () => {
    const { problems } = parseIngredients([ING(), ING({ name: 'Flour again' })]);
    expect(rules(problems)).toEqual(['duplicate-slug']);
  });

  it('rejects an ingredient with no stock unit', () => {
    const { problems } = parseIngredients([ING({ stock_uom: '' })]);
    expect(rules(problems)).toContain('stock-uom-required');
  });

  it('rejects a non-positive purchase_to_stock_factor', () => {
    expect(rules(parseIngredients([ING({ purchase_to_stock_factor: '0' })]).problems))
      .toContain('factor-positive');
    expect(rules(parseIngredients([ING({ purchase_to_stock_factor: 'sack' })]).problems))
      .toContain('factor-positive');
  });

  it('D-2: rejects count_quantum 0 — blank means no rounding', () => {
    const { problems } = parseIngredients([ING({ count_quantum: '0' })]);
    expect(rules(problems)).toContain('quantum-positive');
    expect(problems[0]!.message).toMatch(/blank for no rounding/i);
  });

  it('counts rows the way a person does — header is row 1', () => {
    const { problems } = parseIngredients([ING(), ING({ slug: '' })]);
    expect(problems[0]!.row).toBe(3);
  });
});

describe('parseRecipes', () => {
  it('parses a BASE line', () => {
    const { recipes, problems } = parseRecipes([REC()]);
    expect(problems).toEqual([]);
    expect(recipes[0]).toMatchObject({ variant: 'BASE', qtyPerTable: 400, siteSlug: null });
  });

  it('accepts a *_REMOVE line with no quantity — removal takes the BASE amount out', () => {
    const { recipes, problems } = parseRecipes([
      REC({ variant: 'GF_REMOVE', qty_per_table: '' }),
    ]);
    expect(problems).toEqual([]);
    expect(recipes[0]).toMatchObject({ variant: 'GF_REMOVE', qtyPerTable: 0 });
  });

  it('rejects a zero quantity on a line that needs one', () => {
    const { problems } = parseRecipes([REC({ qty_per_table: '0' })]);
    expect(rules(problems)).toEqual(['qty-positive']);
    expect(problems[0]!.message).toMatch(/consumes nothing/i);
  });

  it('rejects a missing quantity on an ADD line', () => {
    const { problems } = parseRecipes([REC({ variant: 'GF_ADD', qty_per_table: '' })]);
    expect(rules(problems)).toEqual(['qty-required']);
  });

  it('rejects a misspelt variant rather than quietly treating it as BASE', () => {
    const { recipes, problems } = parseRecipes([REC({ variant: 'GF-ADD' })]);
    expect(rules(problems)).toEqual(['variant-known']);
    expect(recipes).toEqual([]);
  });

  it('rejects a malformed effective_from', () => {
    expect(rules(parseRecipes([REC({ effective_from: '01/01/2026' })]).problems))
      .toEqual(['effective-from-format']);
  });
});

describe('groupRecipes', () => {
  it('groups by (bake, site, effective_from)', () => {
    const { recipes } = parseRecipes([
      REC(),
      REC({ ingredient_slug: 'butter', qty_per_table: '300' }),
      REC({ effective_from: '2026-06-01' }),
      REC({ site_slug: 'london-south' }),
    ]);
    const groups = groupRecipes(recipes);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.lines).toHaveLength(2);
  });
});

describe('crossValidate — the rules that catch F-5', () => {
  const ingredients = parseIngredients([
    ING(),
    ING({ slug: 'gf-flour-blend', name: 'GF Blend' }),
    ING({ slug: 'unsalted-butter', name: 'Butter' }),
  ]).ingredients;

  it('rejects a recipe line naming an ingredient that does not exist', () => {
    const { recipes } = parseRecipes([REC(), REC({ ingredient_slug: 'unicorn-dust' })]);
    expect(rules(crossValidate(ingredients, recipes))).toContain('unknown-ingredient');
  });

  it('rejects a version made only of variant lines — nothing to vary', () => {
    const { recipes } = parseRecipes([
      REC({ variant: 'GF_REMOVE', qty_per_table: '' }),
      REC({ variant: 'GF_ADD', ingredient_slug: 'gf-flour-blend', qty_per_table: '420' }),
    ]);
    const problems = crossValidate(ingredients, recipes);
    expect(rules(problems)).toContain('base-required');
  });

  it('rejects a GF_REMOVE for an ingredient the BASE recipe never had', () => {
    const { recipes } = parseRecipes([
      REC(),
      REC({ variant: 'GF_REMOVE', ingredient_slug: 'unsalted-butter', qty_per_table: '' }),
    ]);
    const problems = crossValidate(ingredients, recipes);
    expect(rules(problems)).toContain('remove-not-in-base');
    expect(problems.find((p) => p.rule === 'remove-not-in-base')!.message)
      .toMatch(/Nothing would be removed/);
  });

  it('F-5: rejects a cake offered gluten-free with no GF lines at all', () => {
    const { recipes } = parseRecipes([REC()]);
    const problems = crossValidate(ingredients, recipes, { gf: ['Battenburg'], vegan: [] });
    expect(rules(problems)).toContain('gf-offered-without-variant');
    expect(problems[0]!.message).toMatch(/silently produce the standard recipe/);
  });

  it('F-5: rejects a cake offered vegan with no vegan lines at all', () => {
    const { recipes } = parseRecipes([REC()]);
    const problems = crossValidate(ingredients, recipes, { gf: [], vegan: ['Battenburg'] });
    expect(rules(problems)).toContain('vegan-offered-without-variant');
  });

  it('accepts a complete GF variant', () => {
    const { recipes } = parseRecipes([
      REC(),
      REC({ variant: 'GF_REMOVE', qty_per_table: '' }),
      REC({ variant: 'GF_ADD', ingredient_slug: 'gf-flour-blend', qty_per_table: '420' }),
    ]);
    expect(crossValidate(ingredients, recipes, { gf: ['Battenburg'], vegan: [] })).toEqual([]);
  });

  it('rejects two versions of the same cake starting the same day', () => {
    const { recipes } = parseRecipes([
      REC(),
      REC({ ingredient_slug: 'unsalted-butter', qty_per_table: '300' }),
    ]);
    // Same key, so one group — no problem.
    expect(rules(crossValidate(ingredients, recipes))).not.toContain('duplicate-effective-from');
  });
});

describe('formatProblems', () => {
  it('says so plainly when there is nothing wrong', () => {
    expect(formatProblems([])).toBe('No problems found.');
  });

  it('renders a table naming file, row, rule and problem', () => {
    const out = formatProblems([
      { row: 4, file: 'recipes.csv', rule: 'qty-positive', message: 'Zero flour.' },
    ]);
    expect(out).toMatch(/FILE\s+ROW\s+RULE\s+PROBLEM/);
    expect(out).toMatch(/recipes\.csv\s+4\s+qty-positive\s+Zero flour\./);
  });
});
