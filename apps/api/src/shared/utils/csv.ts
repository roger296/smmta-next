/**
 * CSV rendering for exports an operator opens in Excel.
 *
 * Two things here are not decoration:
 *
 * 1. **Quoting.** A value containing a comma, a quote, a newline or a carriage
 *    return has to be wrapped and its quotes doubled (RFC 4180). Product names
 *    carry commas ("case of 6 × 1.6 kg, assorted") and descriptions carry
 *    newlines, so an unquoted dump silently shifts every column after it.
 *
 * 2. **Formula injection.** Excel and Sheets evaluate a cell whose text starts
 *    with `=`, `+`, `-`, `@`, tab or CR. A product named `=cmd|'…'!A1` is a
 *    live formula the moment somebody opens the export, and product names are
 *    free text typed by whoever added the row. Such a value is prefixed with a
 *    single quote, which Excel shows as text and drops on the way in.
 *
 *    Leading `-` is in that set, which collides with negative numbers — and
 *    Postgres `numeric` arrives here as a STRING, not a number, so every
 *    decimal column in the catalogue (cost, price, weight, pack factor) takes
 *    the string path. A plain numeric literal is therefore exempted, or a
 *    negative cost would land in the sheet as text with a visible apostrophe
 *    and stop being arithmetic. Anything else risky-prefixed is still guarded:
 *    `-lead` and `-1+cmd` are not numeric literals.
 */

const NEEDS_QUOTING = /[",\n\r]/;
const RISKY_PREFIX = /^[=+\-@\t\r]/;
/** A bare number — optional sign, digits, optional fraction/exponent. */
const NUMERIC_LITERAL = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** One CSV cell: stringified, injection-guarded, quoted if it needs to be. */
export function csvCell(value: unknown): string {
  const text = stringify(value);
  if (text === '') return '';
  const risky = RISKY_PREFIX.test(text) && !NUMERIC_LITERAL.test(text);
  const guarded = risky ? `'${text}` : text;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * How each type reaches the sheet.
 *
 * Dates go out as ISO so they sort as text and survive a round trip; JSON
 * columns (gallery URLs, marketplace identifiers, attributes) go out as their
 * JSON so nothing is lost, which is what "all data set in all fields" has to
 * mean for a jsonb column.
 */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** A full CSV document: one header row, then one row per record. */
export function toCsv<T extends Record<string, unknown>>(
  columns: ReadonlyArray<{ header: string; value: (row: T) => unknown }>,
  rows: readonly T[],
): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  }
  // Trailing newline: POSIX text convention, and Excel does not add a blank row.
  return `${lines.join('\r\n')}\r\n`;
}
