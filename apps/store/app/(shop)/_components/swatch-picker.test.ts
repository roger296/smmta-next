/**
 * Source-level contract tests for the swatch picker's stock-flag
 * treatment. The store's vitest runs in a Node environment (no jsdom,
 * no @testing-library/react) — same constraint as
 * `add-to-cart-button.test.tsx`. We assert on the component source
 * rather than rendering it.
 *
 * What this locks down:
 *   - Every swatch button carries a stock flag span.
 *   - The flag uses the brand stock-in / stock-out CSS tokens, never
 *     hardcoded hex (locked palette).
 *   - The accessible name encodes both the colour and the stock state
 *     ("Smoke. In stock.") so screen readers don't depend on colour
 *     alone.
 *   - The flag is `aria-hidden="true"` (state is conveyed via the
 *     accessible name, not redundantly).
 *   - The "In stock" / "Out of stock" labels are present.
 *   - data-test hooks `swatch`, `stock-flag-in` and `stock-flag-out`
 *     exist for e2e selectors.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(path.join(__dirname, 'swatch-picker.tsx'), 'utf8');

describe('SwatchPicker — stock-flag contract', () => {
  it('renders both stock states via per-variant logic', () => {
    expect(SOURCE).toContain("v.availableQty > 0");
    expect(SOURCE).toContain("'In stock'");
    expect(SOURCE).toContain("'Out of stock'");
  });

  it('uses the brand stock CSS tokens — no hardcoded hex', () => {
    expect(SOURCE).toContain('var(--brand-stock-in)');
    expect(SOURCE).toContain('var(--brand-stock-out)');
    // No bare hex codes for green/red sneaking in.
    const flagBlock =
      SOURCE.match(/<span[\s\S]+?data-test=\{variantInStock[\s\S]+?<\/span>/)?.[0] ?? '';
    expect(flagBlock).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('encodes stock state in the accessible name', () => {
    expect(SOURCE).toMatch(/aria-label=\{`\$\{colourLabel\}\. \$\{stockLabel\}\.`\}/);
  });

  it('marks the flag aria-hidden so the accessible name is the single source of truth', () => {
    const flagBlock =
      SOURCE.match(/<span[\s\S]+?data-test=\{variantInStock[\s\S]+?<\/span>/)?.[0] ?? '';
    expect(flagBlock).toContain('aria-hidden="true"');
  });

  it('exposes data-test hooks for e2e selectors', () => {
    expect(SOURCE).toContain('data-test="swatch"');
    expect(SOURCE).toContain("data-test={variantInStock ? 'stock-flag-in' : 'stock-flag-out'}");
  });
});
