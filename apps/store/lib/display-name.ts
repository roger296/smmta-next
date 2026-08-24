/**
 * Product display-name helpers.
 *
 * Catalogue product names already carry the colour ("Landau PLA Basic 1.75mm
 * 1kg — Brown"), because each colour is its own products row. Appending the
 * colour again in the basket / order summary produced "… — Brown — Brown".
 * These helpers append the colour only when the name doesn't already end with
 * it, so both naming styles render correctly.
 */

/** True when `name` already ends with the colour (any separator, any case). */
export function nameIncludesColour(name: string, colour: string): boolean {
  const n = name.trim().toLowerCase();
  const c = colour.trim().toLowerCase();
  if (!c) return true;
  // Match the colour at the end of the string, optionally preceded by a
  // separator (dash, en dash, comma, bracket, slash) and whitespace.
  return new RegExp(`(^|[\\s\\-–—,(/])${escapeRegExp(c)}\\)?$`).test(n);
}

/** The colour suffix to render after `name`, or null when it's already there. */
export function colourSuffix(name: string | null, colour: string | null): string | null {
  if (!colour) return null;
  if (name && nameIncludesColour(name, colour)) return null;
  return colour;
}

/** Single-string form: "<name> — <colour>", de-duplicated. */
export function productDisplayName(name: string, colour?: string | null): string {
  const suffix = colourSuffix(name, colour ?? null);
  return suffix ? `${name} — ${suffix}` : name;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
