/**
 * End-of-bake line arithmetic (Aug-2026 feedback set, F-1 / F-2 / F-3).
 *
 * Extracted from the screen so the two defects below can be asserted directly
 * rather than through six layers of JSX — they are arithmetic bugs, and
 * arithmetic is exactly what a component test is worst at pinning down.
 *
 * ── F-1: "'Table +' and 'Table -' buttons are reversed when switching to
 *          'What's Left' mode" ─────────────────────────────────────────────
 *
 * The plain `−`/`+` steppers were NOT inverted in REMAINING mode, but `Table−`
 * *increased* `remainingQty` and `Table+` *decreased* it. Two controls on the
 * same row moved the same number in opposite directions.
 *
 * The original intent — "one fewer table used means more left" — is defensible
 * read alone and indefensible sitting next to a `+` that does the opposite.
 * **The rule now: every control moves the DISPLAYED NUMBER in its own
 * direction.** In REMAINING mode the displayed number is what's left, so
 * `Table+` adds a table's worth of remaining stock. The buttons are relabelled
 * `+1 table left` / `−1 table left` so the press cannot be misread. This
 * supersedes the old inline comment (recorded in DECISIONS.md).
 *
 * ── F-2: "Toggling to 'What's Left' resets the counter to 0, but toggling
 *          back does not reset it back" ────────────────────────────────────
 *
 * The toggle zeroed the figure it was switching away from, destroying the
 * expected pre-fill. Variance then read `−expected`, the status dot flipped to
 * warn, the "adjusted" counter was wrong, and `doSubmit` sent `actualQty: 0`.
 *
 * Both figures are kept now. Switching changes which one is edited and shown;
 * it never zeroes the other.
 */
export type EntryMode = 'CONSUMED' | 'REMAINING';

export interface ConsumptionLine {
  productId: string;
  name: string;
  stockUom: string;
  expectedQty: number;
  /** One table's worth, straight from the recipe. */
  qtyPerTable: number;
  actualQty: number;
  remainingQty: number;
  entryMode: EntryMode;
  /** False until the baker has actually answered the "what's left" question. */
  remainingSet: boolean;
  wastageQty: number;
  wastageReason: string;
}

/** Quantities are stored to 2dp; repeated fractional adds otherwise drift. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The number this row is currently showing and editing. */
export function displayedQty(line: ConsumptionLine): number {
  return line.entryMode === 'REMAINING' ? line.remainingQty : line.actualQty;
}

/**
 * Move the displayed number by `delta`.
 *
 * F-1: this is the ONLY mutation path for the steppers, so `+`, `−`, `Table+`
 * and `Table−` cannot disagree about direction — they differ only in the size
 * of `delta`.
 */
export function bumpDisplayed(line: ConsumptionLine, delta: number): ConsumptionLine {
  const next = Math.max(0, round2(displayedQty(line) + delta));
  return line.entryMode === 'REMAINING'
    ? { ...line, remainingQty: next, remainingSet: true }
    : { ...line, actualQty: next };
}

/** Set the displayed number outright (from the keypad). */
export function setDisplayed(line: ConsumptionLine, value: number): ConsumptionLine {
  const next = Math.max(0, round2(value));
  return line.entryMode === 'REMAINING'
    ? { ...line, remainingQty: next, remainingSet: true }
    : { ...line, actualQty: next };
}

/**
 * Switch which figure the row is answering with.
 *
 * F-2: **non-destructive**. The figure being switched away from is kept
 * exactly as it was, so switching back restores it. Entering REMAINING for the
 * first time seeds 0 — a fresh, explicit question with no sensible pre-fill —
 * but marks it unanswered (`remainingSet: false`) so a submit can tell "left
 * nothing" from "did not say".
 */
export function toggleMode(line: ConsumptionLine): ConsumptionLine {
  if (line.entryMode === 'REMAINING') {
    return { ...line, entryMode: 'CONSUMED' };
  }
  return {
    ...line,
    entryMode: 'REMAINING',
    remainingQty: line.remainingSet ? line.remainingQty : 0,
  };
}

/**
 * The tables-worth implied by the CURRENT quantity (F-3).
 *
 * The number between the table buttons used to render `covers` — the session
 * total, read-only, identical on every row and unaffected by every press. It
 * now answers "how many tables is what I am looking at?", which is what a
 * number sitting between two table buttons appears to promise.
 *
 * Null when the recipe has no per-table figure: there is no honest answer, and
 * the table buttons are disabled in that case anyway.
 */
export function impliedTables(line: ConsumptionLine): number | null {
  if (!(line.qtyPerTable > 0)) return null;
  return Math.round((displayedQty(line) / line.qtyPerTable) * 10) / 10;
}

/**
 * Variance against the expectation, computed from the mode ACTUALLY IN FORCE.
 *
 * In REMAINING mode the usage is the server's to derive from opening stock, so
 * the form has no consumed figure to compare — reporting a variance would mean
 * inventing one. That is what made the dot flip to `warn` on every toggled row.
 */
export function varianceOf(line: ConsumptionLine): number | null {
  if (line.entryMode === 'REMAINING') return null;
  return round2(line.actualQty - line.expectedQty);
}

/** True when the baker has changed something worth counting as "adjusted". */
export function isAdjusted(line: ConsumptionLine): boolean {
  if (line.wastageQty > 0) return true;
  if (line.entryMode === 'REMAINING') return line.remainingSet;
  return line.actualQty !== line.expectedQty;
}

/** The row's status dot. */
export function statusOf(line: ConsumptionLine): 'done' | 'warn' {
  if (line.wastageQty > 0) return 'warn';
  if (line.entryMode === 'REMAINING') {
    // Unanswered is a warning; an answered "what's left" is fine whatever it is.
    return line.remainingSet ? 'done' : 'warn';
  }
  return varianceOf(line) === 0 ? 'done' : 'warn';
}

/**
 * Lines that cannot be submitted yet (F-8's guard).
 *
 * A REMAINING line with no figure entered would be sent as `remainingQty: 0` —
 * "the shelf is empty" — which is a very different claim from "I haven't
 * counted it".
 */
export function blockedLines(lines: ConsumptionLine[]): ConsumptionLine[] {
  return lines.filter((l) => l.entryMode === 'REMAINING' && !l.remainingSet);
}

/** Benches implied by a table count, when the site has told us the ratio (F-7). */
export function benchesFor(tables: number, benchesPerTable: number | null): number | null {
  if (benchesPerTable == null || !(benchesPerTable > 0)) return null;
  return Math.round(tables * benchesPerTable * 10) / 10;
}
