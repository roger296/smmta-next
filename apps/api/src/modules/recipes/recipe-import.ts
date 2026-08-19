/**
 * Recipe CSV import — parsing and validation (Aug-2026 feedback set, F-4/F-5).
 *
 * "Displayed recipes are not part of our offering of course."
 * "Selecting Vegan or GF options for Battenburg failed to generate required
 *  ingredients."
 *
 * The four demo cakes were invented, and every seeded line was `BASE` — so the
 * server-side variant machinery (`GF_REMOVE` / `GF_ADD` / `VEGAN_REMOVE` /
 * `VEGAN_ADD`, which works correctly) had nothing to act on. Selecting GF
 * silently produced the standard ingredient list.
 *
 * This module is the pure half: parse two CSVs, and refuse an import that
 * would reproduce the 12 Aug situation. The I/O and the writes live in
 * `scripts/import-recipes.ts`.
 *
 * The validation is deliberately **fail-the-whole-import**, not
 * skip-the-bad-row. A half-imported menu is harder to reason about than none,
 * and every rule below describes something that becomes invisible once it is
 * in the database — which is exactly how F-5 survived to a live test.
 */
import { RECIPE_LINE_VARIANTS, REMOVAL_VARIANTS, type RecipeLineVariant } from './recipe.service.js';

export interface IngredientRow {
  slug: string;
  name: string;
  stockUom: string;
  purchaseUom: string | null;
  purchaseToStockFactor: number;
  packDescription: string | null;
  expectedNextCost: number;
  barcode: string | null;
  countQuantum: number | null;
}

export interface RecipeRow {
  bake: string;
  effectiveFrom: string;
  siteSlug: string | null;
  variant: RecipeLineVariant;
  ingredientSlug: string;
  qtyPerTable: number;
  unitCost: number | null;
}

export interface ImportProblem {
  /** 1-based row number in the source file, as a person counts them. */
  row: number;
  file: 'ingredients.csv' | 'recipes.csv';
  rule: string;
  message: string;
}

export interface ParsedImport {
  ingredients: IngredientRow[];
  recipes: RecipeRow[];
  problems: ImportProblem[];
}

const REQUIRED_INGREDIENT_COLUMNS = [
  'slug',
  'name',
  'stock_uom',
  'purchase_uom',
  'purchase_to_stock_factor',
  'pack_description',
  'expected_next_cost',
  'barcode',
  'count_quantum',
] as const;

const REQUIRED_RECIPE_COLUMNS = [
  'bake',
  'effective_from',
  'site_slug',
  'variant',
  'ingredient_slug',
  'qty_per_table',
  'unit_cost',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function blankToNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function numberOr(value: string | undefined, fallback: number): number {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : NaN;
}

export function missingColumns(
  header: string[],
  required: readonly string[],
): string[] {
  const present = new Set(header.map((h) => h.trim().toLowerCase()));
  return required.filter((c) => !present.has(c));
}

/** Parse the ingredient rows, collecting problems rather than throwing. */
export function parseIngredients(rows: Array<Record<string, string>>): {
  ingredients: IngredientRow[];
  problems: ImportProblem[];
} {
  const ingredients: IngredientRow[] = [];
  const problems: ImportProblem[] = [];
  const seen = new Set<string>();

  rows.forEach((raw, i) => {
    // +2: one for the header line, one because people count from 1.
    const row = i + 2;
    const slug = (raw.slug ?? '').trim();
    const name = (raw.name ?? '').trim();

    if (!slug) {
      problems.push({ row, file: 'ingredients.csv', rule: 'slug-required', message: 'No slug.' });
      return;
    }
    if (seen.has(slug)) {
      problems.push({
        row,
        file: 'ingredients.csv',
        rule: 'duplicate-slug',
        message: `Slug "${slug}" appears more than once.`,
      });
      return;
    }
    seen.add(slug);

    if (!name) {
      problems.push({
        row,
        file: 'ingredients.csv',
        rule: 'name-required',
        message: `"${slug}" has no name.`,
      });
    }

    const stockUom = (raw.stock_uom ?? '').trim();
    if (!stockUom) {
      problems.push({
        row,
        file: 'ingredients.csv',
        rule: 'stock-uom-required',
        message: `"${slug}" has no stock unit. Recipes are written in this unit.`,
      });
    }

    const factor = numberOr(raw.purchase_to_stock_factor, 1);
    if (!Number.isFinite(factor) || factor <= 0) {
      problems.push({
        row,
        file: 'ingredients.csv',
        rule: 'factor-positive',
        message: `"${slug}" has a purchase_to_stock_factor of "${raw.purchase_to_stock_factor}". It must be a positive number.`,
      });
    }

    const cost = numberOr(raw.expected_next_cost, 0);
    if (!Number.isFinite(cost) || cost < 0) {
      problems.push({
        row,
        file: 'ingredients.csv',
        rule: 'cost-non-negative',
        message: `"${slug}" has an expected_next_cost of "${raw.expected_next_cost}".`,
      });
    }

    const quantumRaw = blankToNull(raw.count_quantum);
    const quantum = quantumRaw === null ? null : Number(quantumRaw);
    if (quantum !== null && (!Number.isFinite(quantum) || quantum <= 0)) {
      problems.push({
        row,
        file: 'ingredients.csv',
        rule: 'quantum-positive',
        // Defect D-2: "no bucketing" is spelled blank, never 0.
        message: `"${slug}" has a count_quantum of "${quantumRaw}". Leave it blank for no rounding; 0 is not a valid quantum.`,
      });
    }

    ingredients.push({
      slug,
      name,
      stockUom,
      purchaseUom: blankToNull(raw.purchase_uom),
      purchaseToStockFactor: Number.isFinite(factor) ? factor : 1,
      packDescription: blankToNull(raw.pack_description),
      expectedNextCost: Number.isFinite(cost) ? cost : 0,
      barcode: blankToNull(raw.barcode),
      countQuantum: quantum,
    });
  });

  return { ingredients, problems };
}

/** Parse the recipe rows, collecting problems rather than throwing. */
export function parseRecipes(rows: Array<Record<string, string>>): {
  recipes: RecipeRow[];
  problems: ImportProblem[];
} {
  const recipes: RecipeRow[] = [];
  const problems: ImportProblem[] = [];

  rows.forEach((raw, i) => {
    const row = i + 2;
    const bake = (raw.bake ?? '').trim();
    const ingredientSlug = (raw.ingredient_slug ?? '').trim();
    const variantRaw = ((raw.variant ?? '').trim() || 'BASE').toUpperCase();
    const effectiveFrom = (raw.effective_from ?? '').trim();

    if (!bake) {
      problems.push({ row, file: 'recipes.csv', rule: 'bake-required', message: 'No bake.' });
      return;
    }
    if (!ingredientSlug) {
      problems.push({
        row,
        file: 'recipes.csv',
        rule: 'ingredient-required',
        message: `"${bake}" has a line with no ingredient_slug.`,
      });
      return;
    }
    if (!DATE_RE.test(effectiveFrom)) {
      problems.push({
        row,
        file: 'recipes.csv',
        rule: 'effective-from-format',
        message: `"${bake}" has effective_from "${effectiveFrom}". Use YYYY-MM-DD.`,
      });
      return;
    }
    if (!(RECIPE_LINE_VARIANTS as readonly string[]).includes(variantRaw)) {
      problems.push({
        row,
        file: 'recipes.csv',
        rule: 'variant-known',
        message: `"${bake}" line "${ingredientSlug}" has variant "${variantRaw}". Use one of ${RECIPE_LINE_VARIANTS.join(', ')}.`,
      });
      return;
    }
    const variant = variantRaw as RecipeLineVariant;
    const isRemoval = REMOVAL_VARIANTS.includes(variant);

    const qtyRaw = (raw.qty_per_table ?? '').trim();
    // A *_REMOVE line takes the whole ingredient out, so its quantity carries
    // no meaning — the service stores 0. Requiring one would be noise.
    const qty = isRemoval ? 0 : Number(qtyRaw);

    if (!isRemoval) {
      if (qtyRaw === '' || !Number.isFinite(qty)) {
        problems.push({
          row,
          file: 'recipes.csv',
          rule: 'qty-required',
          message: `"${bake}" line "${ingredientSlug}" (${variant}) has no qty_per_table.`,
        });
        return;
      }
      if (qty <= 0) {
        problems.push({
          row,
          file: 'recipes.csv',
          rule: 'qty-positive',
          // A zero-quantity line is invisible in every downstream figure while
          // still looking, in the editor, like the ingredient is accounted for.
          message: `"${bake}" line "${ingredientSlug}" has qty_per_table ${qty}. A zero-quantity line consumes nothing and hides a missing number.`,
        });
        return;
      }
    }

    const unitCostRaw = blankToNull(raw.unit_cost);
    const unitCost = unitCostRaw === null ? null : Number(unitCostRaw);
    if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) {
      problems.push({
        row,
        file: 'recipes.csv',
        rule: 'unit-cost-valid',
        message: `"${bake}" line "${ingredientSlug}" has unit_cost "${unitCostRaw}".`,
      });
      return;
    }

    recipes.push({
      bake,
      effectiveFrom,
      siteSlug: blankToNull(raw.site_slug),
      variant,
      ingredientSlug,
      qtyPerTable: qty,
      unitCost,
    });
  });

  return { recipes, problems };
}

/** One recipe version, as the importer groups the rows. */
export interface RecipeGroup {
  key: string;
  bake: string;
  siteSlug: string | null;
  effectiveFrom: string;
  lines: RecipeRow[];
}

export function groupRecipes(rows: RecipeRow[]): RecipeGroup[] {
  const groups = new Map<string, RecipeGroup>();
  for (const row of rows) {
    const key = `${row.bake}|${row.siteSlug ?? ''}|${row.effectiveFrom}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, bake: row.bake, siteSlug: row.siteSlug, effectiveFrom: row.effectiveFrom, lines: [] };
      groups.set(key, group);
    }
    group.lines.push(row);
  }
  return [...groups.values()];
}

/**
 * The cross-row rules — the ones that catch F-5.
 *
 * Each of these describes something that becomes invisible once it is in the
 * database: a GF variant that removes an ingredient the recipe never had, an
 * ADD line with no quantity, a cake offering a diet it has no recipe for.
 * Every one of them would present to a baker as "the ingredients just didn't
 * appear".
 */
export function crossValidate(
  ingredients: IngredientRow[],
  rows: RecipeRow[],
  /** Bakes the venue can offer GF / vegan tables for, if known. */
  dietaryOffered: { gf: string[]; vegan: string[] } = { gf: [], vegan: [] },
): ImportProblem[] {
  const problems: ImportProblem[] = [];
  const known = new Set(ingredients.map((i) => i.slug));
  const rowNumberOf = new Map<RecipeRow, number>();
  rows.forEach((r, i) => rowNumberOf.set(r, i + 2));

  // Unknown ingredient slugs.
  for (const row of rows) {
    if (!known.has(row.ingredientSlug)) {
      problems.push({
        row: rowNumberOf.get(row)!,
        file: 'recipes.csv',
        rule: 'unknown-ingredient',
        message: `"${row.bake}" references ingredient "${row.ingredientSlug}", which is not in ingredients.csv.`,
      });
    }
  }

  for (const group of groupRecipes(rows)) {
    const base = new Set(
      group.lines.filter((l) => l.variant === 'BASE').map((l) => l.ingredientSlug),
    );
    const where = `${group.bake}${group.siteSlug ? ` @ ${group.siteSlug}` : ''} from ${group.effectiveFrom}`;

    if (base.size === 0) {
      problems.push({
        row: rowNumberOf.get(group.lines[0]!)!,
        file: 'recipes.csv',
        rule: 'base-required',
        message: `${where} has no BASE lines. A variant with no standard recipe to vary produces nothing.`,
      });
    }

    // A *_REMOVE naming an ingredient the BASE recipe does not contain.
    for (const line of group.lines) {
      if (!REMOVAL_VARIANTS.includes(line.variant)) continue;
      if (!base.has(line.ingredientSlug)) {
        problems.push({
          row: rowNumberOf.get(line)!,
          file: 'recipes.csv',
          rule: 'remove-not-in-base',
          message: `${where}: ${line.variant} removes "${line.ingredientSlug}", which is not in the BASE recipe. Nothing would be removed.`,
        });
      }
    }

    // A diet offered with no variant lines at all — F-5 exactly.
    const hasGf = group.lines.some((l) => l.variant === 'GF_REMOVE' || l.variant === 'GF_ADD');
    const hasVegan = group.lines.some(
      (l) => l.variant === 'VEGAN_REMOVE' || l.variant === 'VEGAN_ADD',
    );
    if (dietaryOffered.gf.includes(group.bake) && !hasGf) {
      problems.push({
        row: rowNumberOf.get(group.lines[0]!)!,
        file: 'recipes.csv',
        rule: 'gf-offered-without-variant',
        message: `${where} is offered gluten-free but has no GF_REMOVE / GF_ADD lines. Selecting GF would silently produce the standard recipe.`,
      });
    }
    if (dietaryOffered.vegan.includes(group.bake) && !hasVegan) {
      problems.push({
        row: rowNumberOf.get(group.lines[0]!)!,
        file: 'recipes.csv',
        rule: 'vegan-offered-without-variant',
        message: `${where} is offered vegan but has no VEGAN_REMOVE / VEGAN_ADD lines. Selecting vegan would silently produce the standard recipe.`,
      });
    }
  }

  // Two versions of the same (bake, site) sharing an effective_from.
  const byKey = new Map<string, Set<string>>();
  for (const group of groupRecipes(rows)) {
    const k = `${group.bake}|${group.siteSlug ?? ''}`;
    const dates = byKey.get(k) ?? new Set<string>();
    if (dates.has(group.effectiveFrom)) {
      problems.push({
        row: rowNumberOf.get(group.lines[0]!)!,
        file: 'recipes.csv',
        rule: 'duplicate-effective-from',
        message: `${group.bake} has two recipes effective from ${group.effectiveFrom}. Which one applies is undefined.`,
      });
    }
    dates.add(group.effectiveFrom);
    byKey.set(k, dates);
  }

  return problems;
}

/** Render the problems as the table the report prints. */
export function formatProblems(problems: ImportProblem[]): string {
  if (problems.length === 0) return 'No problems found.';
  const header = ['FILE', 'ROW', 'RULE', 'PROBLEM'];
  const rows = problems.map((p) => [p.file, String(p.row), p.rule, p.message]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  // The message column is left unpadded — padding it to the longest message
  // makes the table unreadable in a terminal.
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
