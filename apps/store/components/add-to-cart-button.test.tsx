/**
 * Locks down the contract the Playwright e2e suites depend on. The
 * Add-to-Cart control must remain a `type="button"` element with the
 * accessible name "Add to cart" (the test selectors find it via
 * `page.getByRole('button', { name: /^add to cart$/i })`).
 *
 * Added by the Prompt 15 bug fix: the original e2e selector was
 * `button[type="submit"]` against a `type="button"` element, which timed
 * out at 60 s and obscured the real shape of the component. A future
 * refactor that swaps the button into a <form type="submit"> would
 * silently break checkout-happy-path.spec.ts and checkout-sad-paths.spec.ts.
 *
 * Implementation note: `apps/store/vitest` runs in a Node environment
 * (no jsdom, no @testing-library/react), so this test asserts on the
 * component source directly rather than rendering React. It's coarser
 * than a render-based test but it's free of test-environment dependencies
 * and catches the exact regression we just fixed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  path.join(__dirname, 'add-to-cart-button.tsx'),
  'utf8',
);

describe('AddToCartButton — component contract', () => {
  it('uses `type="button"` (the e2e selectors depend on this)', () => {
    // Both branches of the component (in-stock and out-of-stock) must
    // render type="button". A submit button would re-introduce the
    // 60-second Playwright timeout the Prompt 15 fix resolved.
    const buttonTypeMatches = SOURCE.match(/<button\s[^>]*type="([^"]+)"/g) ?? [];
    expect(buttonTypeMatches.length).toBeGreaterThanOrEqual(2);
    for (const m of buttonTypeMatches) {
      expect(m).toContain('type="button"');
    }
    // And nothing in this file should ever render type="submit".
    expect(SOURCE).not.toMatch(/type="submit"/);
  });

  it('keeps the accessible name "Add to cart" as the default label', () => {
    // The e2e regex is /^add to cart$/i — this label must remain the
    // visible text content of the in-stock button.
    expect(SOURCE).toMatch(/label\s*=\s*['"]Add to cart['"]/);
  });

  it('shows "Added" after a successful add (drives the e2e wait)', () => {
    // The Playwright tests wait for `getByRole('button', { name: /^added/i })`
    // before navigating to /cart, so the component must surface a label
    // beginning with "Added" when the mutation resolves.
    expect(SOURCE).toMatch(/Added\s*✓/);
  });

  it('disables the in-stock button while the mutation is pending', () => {
    // Locks `disabled={mutation.isPending}` (or equivalent) so the e2e
    // tests don't double-fire on a slow add.
    expect(SOURCE).toMatch(/disabled=\{mutation\.isPending\}/);
  });
});
