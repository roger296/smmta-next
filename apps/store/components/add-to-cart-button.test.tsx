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
import { readFileSync, readdirSync } from 'node:fs';
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
    // Slice to the next top-level function rather than the first closing
    // brace — the component now contains nested closures (the quantity
    // handlers), so a non-greedy match to `\n}` stops early and reads
    // almost none of the component.
    const start = SOURCE.indexOf('function AddToCartActiveButton');
    const end = SOURCE.indexOf('function NotifyMeForm');
    const activeBlock = start >= 0 && end > start ? SOURCE.slice(start, end) : '';
    expect(activeBlock).toMatch(/type="button"/);
    expect(activeBlock).not.toMatch(/type="submit"/);
  });

  it('keeps the accessible name "Add to cart" as the default label', () => {
    // The e2e regex is /^add to cart$/i — this label must remain the
    // visible text content of the in-stock button.
    expect(SOURCE).toMatch(/label\s*=\s*['"]Add to cart['"]/);
  });

  it('confirms the add next to the button, not only in the header badge', () => {
    // Bug 11 from the September audit: the only confirmation was the
    // header cart badge, which on a product page sits off-screen above
    // the fold — so the natural next move was to press Add again. The
    // confirmation now renders under the control that caused it, with
    // role="status" so it is announced, and a link onward to the basket.
    //
    // The Playwright suites wait on this element (see
    // checkout-happy-path.spec.ts), so its role and text are a contract.
    expect(SOURCE).toMatch(/role="status"/);
    expect(SOURCE).toMatch(/Added\{quantity > 1/);
    expect(SOURCE).toMatch(/View basket/);
  });

  it('no e2e spec still waits on the removed "Added" BUTTON label', () => {
    // This exists because of a real miss. When the confirmation moved
    // out of the button label into a role="status" element, one of the
    // four e2e call sites was updated and three were not — so CI went
    // red on a change that was otherwise correct, and the unit suite
    // said nothing because it only ever read this component's source.
    //
    // The waits now live in e2e/_helpers/cart.ts so there is one
    // definition to update. This test guards against a new spec
    // reintroducing the old selector by hand.
    const specDir = path.join(__dirname, '..', 'e2e');
    const offenders = readdirSync(specDir)
      .filter((f) => f.endsWith('.spec.ts'))
      .filter((f) =>
        /getByRole\(\s*['"]button['"]\s*,\s*\{\s*name:\s*\/\^?added/i.test(
          readFileSync(path.join(specDir, f), 'utf8'),
        ),
      );
    expect(
      offenders,
      `these specs wait on a button named "Added", which the component no longer renders — use addSelectedVariantToCart() from e2e/_helpers/cart.ts`,
    ).toEqual([]);
  });

  it('offers a quantity stepper on the product page (UX 05)', () => {
    // Buying three spools previously meant adding one, navigating to the
    // basket and pressing + twice — while the FAQ advertised a 10+
    // discount, i.e. actively promoting a route that was never built.
    expect(SOURCE).toMatch(/aria-label="Increase quantity"/);
    expect(SOURCE).toMatch(/aria-label="Decrease quantity"/);
  });

  it('disables the in-stock button while the mutation is pending', () => {
    // Locks `disabled={mutation.isPending}` (or equivalent) so the e2e
    // tests don't double-fire on a slow add.
    expect(SOURCE).toMatch(/disabled=\{mutation\.isPending\}/);
  });
});
