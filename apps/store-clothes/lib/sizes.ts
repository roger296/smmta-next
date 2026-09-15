/**
 * Garment size ordering for the range page picker and the listing cards.
 *
 * The same rules as the API's `apps/api/src/modules/storefront/sizes.ts`,
 * which orders the sizes it sends on each listing; kept as a copy rather
 * than a shared package, as with the rest of the storefront.
 *
 * Letter sizes smallest to largest (XXS and 2XS alike), with combined sizes
 * (S/M) and fits (MR, "M (CLS)") beside their letter size; then codes that
 * start with a number (ages 7/8, waists 30R, necks 15.5) by that number;
 * then anything else alphabetically.
 */

const LETTER_SIZE = /^(\d)?(X*)(S|M|L)$/;
const FIT_SUFFIX = /^(.+?)(R|L|S|T|U|Y)$/;

/** Where a plain letter size sits on a scale with M at 0, or null when the
 *  code isn't one: XS is -2, 2XS and XXS are -3, XL is 2, 2XL and XXL are 3. */
export function letterSizeValue(code: string): number | null {
  const m = LETTER_SIZE.exec(code.trim().toUpperCase());
  if (!m) return null;
  const digit = m[1];
  const xs = m[2]!.length;
  const base = m[3];
  if (digit && xs !== 1) return null;
  if (base === 'M') return digit || xs > 0 ? null : 0;
  const steps = digit ? Number(digit) : xs;
  return base === 'S' ? -1 - steps : 1 + steps;
}

function sizeSortKey(code: string): [number, number] {
  const c = code.trim().toUpperCase().replace(/\s*\(.*\)$/, '');
  const letter = letterSizeValue(c);
  if (letter !== null) return [0, letter];

  const parts = c.split('/');
  if (parts.length === 2) {
    const first = letterSizeValue(parts[0]!);
    if (first !== null && letterSizeValue(parts[1]!) !== null) return [0, first + 0.5];
  }

  const fit = FIT_SUFFIX.exec(c);
  if (fit) {
    const base = letterSizeValue(fit[1]!);
    if (base !== null) return [0, base + 0.1];
  }

  const number = /^(\d+(?:\.\d+)?)/.exec(c);
  if (number) return [1, Number(number[1])];

  return [2, 0];
}

/** Comparator for `Array.prototype.sort` over size codes. */
export function compareSizes(a: string, b: string): number {
  const [at, av] = sizeSortKey(a);
  const [bt, bv] = sizeSortKey(b);
  if (at !== bt) return at - bt;
  if (av !== bv) return av - bv;
  return a.localeCompare(b, 'en', { numeric: true });
}
