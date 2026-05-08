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
  it('the in-stock add-to-cart button uses `type="button"` (the e2e selectors depend on this)', () => {
    // The in-stock branch lives inside `AddToCartActiveButton` — that's
    // the component the Playwright tests target. It must render
    // type="button"; a submit button would re-introduce the 60-second
    // timeout the Prompt 15 fix resolved.
    //
    // The notify-me form (out-of-stock branch) legitimately uses
    // `<button type="submit">` because it's inside an actual <form> —
    // that's a different component and the e2e tests don't touch it.
    const activeBlock =
      SOURCE.match(/function AddToCartActiveButton[\s\S]+?\n\}/)?.[0] ?? '';
    expect(activeBlock).toMatch(/type="button"/);
    expect(activeBlock).not.toMatch(/type="submit"/);
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
