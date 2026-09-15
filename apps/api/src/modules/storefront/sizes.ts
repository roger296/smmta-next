/**
 * Garment size ordering.
 *
 * Supplier size codes are untidy. Ralawise alone uses letter sizes (XS to
 * 7XL, with XXS and XXL as well as 2XS and 2XL), combined sizes (S/M,
 * 2XL/3XL), a fit after a letter size (MR, XLL, "M (CLS)"), ages (7/8,
 * 12/13), waists with leg lengths (30R, 32L) and neck sizes (15.5).
 *
 * The order is best-effort: letter sizes smallest to largest, then every
 * code that starts with a number by that number, then anything else
 * alphabetically ("One Size").
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
  // "2XL" has a count and one X; "2L" and "2XXL" aren't sizes.
  if (digit && xs !== 1) return null;
  if (base === 'M') return digit || xs > 0 ? null : 0;
  const steps = digit ? Number(digit) : xs;
  return base === 'S' ? -1 - steps : 1 + steps;
}

/** [tier, value]: tier 0 letter sizes, 1 codes starting with a number, 2 the rest. */
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
