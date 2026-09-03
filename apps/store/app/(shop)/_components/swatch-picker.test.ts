/**
 * Source-level contract tests for the swatch picker's stock-flag
 * treatment. The store's vitest runs in a Node environment (no jsdom,
 * no @testing-library/react) — same constraint as
 * `add-to-cart-button.test.tsx`. We assert on the component source
 * rather than rendering it.
 *
 * What this locks down:
 *   - Per-variant stock-flag rendering using `effectiveStockState`.
 *   - The flag uses the brand stock-in / stock-out CSS tokens, never
 *     hardcoded hex (locked palette).
 *   - The accessible name encodes both the colour and the stock state.
 *   - The flag is `aria-hidden="true"`.
 *   - data-test hooks `swatch`, `stock-flag-in`, `stock-flag-out`,
 *     and a `data-stock-state` attribute carrying the three-state
 *     enum value.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(path.join(__dirname, 'swatch-picker.tsx'), 'utf8');

describe('SwatchPicker — stock-flag contract', () => {
  it('renders state via effectiveStockState (three-state-aware)', () => {
    expect(SOURCE).toContain('effectiveStockState(v)');
    expect(SOURCE).toContain('isSellable(state)');
    expect(SOURCE).toContain('DISPATCH_COPY[state].badgeLabel');
  });

  it('uses the brand stock CSS tokens — no hardcoded hex in the flag span', () => {
    expect(SOURCE).toContain('var(--brand-stock-in)');
    expect(SOURCE).toContain('var(--brand-stock-out)');
    const flagBlock =
      SOURCE.match(/<span[\s\S]+?data-test=\{flagDataTest\}[\s\S]+?<\/span>/)?.[0] ?? '';
    expect(flagBlock).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('encodes stock state in the accessible name', () => {
    // The label now also carries the price when colours differ in price
    // (UX 03), so this asserts the two parts that matter rather than the
    // exact template: a screen-reader user must hear the colour AND
    // whether it can be bought, without depending on the visual flag.
    expect(SOURCE).toMatch(/aria-label=\{`\$\{colourLabel\}\. \$\{stockLabel\}\./);
  });

  it('de-emphasises unavailable swatches by more than colour alone', () => {
    // UX 03: out-of-stock colours carried identical visual weight to
    // buyable ones. Opacity plus a diagonal rule through the swatch dot
    // — the rule matters because opacity alone still reads as "colour",
    // which is exactly what a colour-blind customer can't rely on.
    expect(SOURCE).toContain('opacity-55');
    expect(SOURCE).toMatch(/linear-gradient\(to top right/);
  });

  it('marks the flag aria-hidden so the accessible name is the single source of truth', () => {
    const flagBlock =
      SOURCE.match(/<span[\s\S]+?data-test=\{flagDataTest\}[\s\S]+?<\/span>/)?.[0] ?? '';
    expect(flagBlock).toContain('aria-hidden="true"');
  });

  it('exposes data-test hooks + data-stock-state for e2e selectors', () => {
    expect(SOURCE).toContain('data-test="swatch"');
    expect(SOURCE).toContain("data-test={flagDataTest}");
    expect(SOURCE).toContain('data-stock-state={state}');
  });

  it('sellable states (IN_STOCK + AVAILABLE_FROM_SUPPLIER) share the green flag', () => {
    // The per-state colour resolution is "sellable → green token,
    // else red token" — both green states deliberately use the same
    // var(--brand-stock-in) token (per the spec: "two greens, no
    // amber").
    expect(SOURCE).toContain('const sellable = isSellable(state)');
    // The colour ternary uses sellable → stock-in : stock-out.
    expect(SOURCE).toMatch(
      /sellable\s*\?\s*['"]var\(--brand-stock-in\)['"]\s*:\s*['"]var\(--brand-stock-out\)['"]/,
    );
  });
});
