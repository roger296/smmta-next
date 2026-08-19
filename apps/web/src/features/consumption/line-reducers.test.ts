/**
 * End-of-bake line arithmetic (Aug-2026 feedback set, F-1 / F-2 / F-3 / F-7).
 *
 * "'Table +' and 'Table -' buttons are reversed when switching to 'What's
 *  Left' mode."
 * "Toggling to 'What's Left' resets the counter to 0, but toggling back does
 *  not reset it back."
 */
import { describe, expect, it } from 'vitest';
import {
  benchesFor,
  blockedLines,
  bumpDisplayed,
  displayedQty,
  impliedTables,
  isAdjusted,
  setDisplayed,
  statusOf,
  toggleMode,
  varianceOf,
  type ConsumptionLine,
} from './line-reducers';

const line = (over: Partial<ConsumptionLine> = {}): ConsumptionLine => ({
  productId: 'flour',
  name: 'Plain flour',
  stockUom: 'g',
  expectedQty: 500,
  qtyPerTable: 100,
  actualQty: 500,
  remainingQty: 0,
  remainingSet: false,
  entryMode: 'CONSUMED',
  wastageQty: 0,
  wastageReason: '',
  ...over,
});

// ── F-1: every control moves the displayed number in its own direction ──────
describe('F-1: direction consistency', () => {
  /** The four controls, as deltas. `Table±` differs only in step size. */
  const CONTROLS = [
    { label: '+', delta: 1, expects: 'up' as const },
    { label: '−', delta: -1, expects: 'down' as const },
    { label: 'Table+', delta: 100, expects: 'up' as const },
    { label: 'Table−', delta: -100, expects: 'down' as const },
  ];

  const MODES = [
    { mode: 'CONSUMED' as const, start: line({ actualQty: 500 }) },
    { mode: 'REMAINING' as const, start: line({ entryMode: 'REMAINING', remainingQty: 500, remainingSet: true }) },
  ];

  for (const { mode, start } of MODES) {
    for (const control of CONTROLS) {
      it(`F-1: in ${mode} mode, "${control.label}" moves the displayed number ${control.expects}`, () => {
        const before = displayedQty(start);
        const after = displayedQty(bumpDisplayed(start, control.delta));
        if (control.expects === 'up') expect(after).toBeGreaterThan(before);
        else expect(after).toBeLessThan(before);
      });
    }
  }

  it('F-1 REGRESSION: in REMAINING mode Table+ and + agree — they used to oppose', () => {
    const start = line({ entryMode: 'REMAINING', remainingQty: 500, remainingSet: true });
    const plusOne = displayedQty(bumpDisplayed(start, 1));
    const plusTable = displayedQty(bumpDisplayed(start, start.qtyPerTable));
    // Pre-F12, `Table−` increased remainingQty while `+` also increased it, so
    // the two buttons beside each other moved the same number opposite ways.
    expect(plusOne).toBeGreaterThan(500);
    expect(plusTable).toBeGreaterThan(500);
    expect(plusTable).toBeGreaterThan(plusOne);
  });

  it('never goes below zero', () => {
    const start = line({ actualQty: 50 });
    expect(displayedQty(bumpDisplayed(start, -100))).toBe(0);
  });

  it('does not drift on repeated fractional steps', () => {
    let l = line({ actualQty: 0, qtyPerTable: 0.25 });
    for (let i = 0; i < 3; i += 1) l = bumpDisplayed(l, l.qtyPerTable);
    expect(displayedQty(l)).toBe(0.75);
  });
});

// ── F-2: the toggle is non-destructive ──────────────────────────────────────
describe('F-2: switching mode keeps both figures', () => {
  it('F-2 REGRESSION: CONSUMED(500) → REMAINING → CONSUMED restores 500, not 0', () => {
    const start = line({ actualQty: 500 });
    const toRemaining = toggleMode(start);
    const backToConsumed = toggleMode(toRemaining);
    expect(backToConsumed.actualQty).toBe(500);
    expect(displayedQty(backToConsumed)).toBe(500);
  });

  it('entering REMAINING seeds 0 — a fresh, explicit question', () => {
    const toRemaining = toggleMode(line({ actualQty: 500 }));
    expect(toRemaining.entryMode).toBe('REMAINING');
    expect(displayedQty(toRemaining)).toBe(0);
    // ...but marked unanswered, so a submit can tell "left nothing" from
    // "did not say".
    expect(toRemaining.remainingSet).toBe(false);
  });

  it('an ANSWERED remaining figure survives a round trip too', () => {
    let l = toggleMode(line({ actualQty: 500 }));
    l = setDisplayed(l, 120);
    expect(l.remainingSet).toBe(true);

    l = toggleMode(l); // → CONSUMED
    expect(displayedQty(l)).toBe(500);
    l = toggleMode(l); // → REMAINING again
    expect(displayedQty(l)).toBe(120);
  });

  it('F-2: variance is NOT reported in REMAINING mode', () => {
    const consumed = line({ actualQty: 500, expectedQty: 500 });
    expect(varianceOf(consumed)).toBe(0);

    const remaining = toggleMode(consumed);
    // Pre-F12 this read −500 (the toggle had zeroed actualQty), flipping the
    // status dot to warn on every toggled row. The usage is the server's to
    // derive; the form has no consumed figure to compare.
    expect(varianceOf(remaining)).toBeNull();
    expect(statusOf(remaining)).toBe('warn'); // because it is unanswered...
    expect(statusOf(setDisplayed(remaining, 0))).toBe('done'); // ...not because of variance
  });

  it('F-2: a freshly toggled line is not counted as "adjusted"', () => {
    const consumed = line({ actualQty: 500, expectedQty: 500 });
    expect(isAdjusted(consumed)).toBe(false);
    const remaining = toggleMode(consumed);
    expect(isAdjusted(remaining)).toBe(false);
    expect(isAdjusted(setDisplayed(remaining, 120))).toBe(true);
  });
});

// ── F-3: the live table count ───────────────────────────────────────────────
describe('F-3: the number between the table buttons', () => {
  it('F-3: shows the tables implied by the CURRENT quantity, not the session total', () => {
    const l = line({ actualQty: 250, qtyPerTable: 100 });
    expect(impliedTables(l)).toBe(2.5);
  });

  it('F-3: updates on every press', () => {
    let l = line({ actualQty: 500, qtyPerTable: 100 });
    expect(impliedTables(l)).toBe(5);
    l = bumpDisplayed(l, l.qtyPerTable);
    expect(impliedTables(l)).toBe(6);
  });

  it('tracks the remaining figure in REMAINING mode', () => {
    const l = line({ entryMode: 'REMAINING', remainingQty: 300, remainingSet: true, qtyPerTable: 100 });
    expect(impliedTables(l)).toBe(3);
  });

  it('is null when the recipe has no per-table figure — no honest answer', () => {
    expect(impliedTables(line({ qtyPerTable: 0 }))).toBeNull();
  });

  it('rounds to one decimal, so a part-table is visible but not noisy', () => {
    expect(impliedTables(line({ actualQty: 233, qtyPerTable: 100 }))).toBe(2.3);
  });
});

// ── F-7: benches ────────────────────────────────────────────────────────────
describe('F-7: bench derivation', () => {
  it('derives benches from the site setting', () => {
    expect(benchesFor(4, 6)).toBe(24);
    expect(benchesFor(2.5, 6)).toBe(15);
  });

  it('is null when the site has no setting — the UI says so rather than guessing', () => {
    expect(benchesFor(4, null)).toBeNull();
  });

  it('treats a zero or negative ratio as unset', () => {
    expect(benchesFor(4, 0)).toBeNull();
    expect(benchesFor(4, -2)).toBeNull();
  });
});

// ── F-8: the submit guard ───────────────────────────────────────────────────
describe('F-8: an uncounted REMAINING line blocks the submit', () => {
  it('blocks a REMAINING line with no figure entered', () => {
    const untouched = toggleMode(line());
    expect(blockedLines([untouched])).toHaveLength(1);
  });

  it('allows it once answered — including an explicit zero', () => {
    const answered = setDisplayed(toggleMode(line()), 0);
    // "The shelf is empty" is a real answer; "I haven't counted it" is not.
    expect(blockedLines([answered])).toHaveLength(0);
  });

  it('never blocks a CONSUMED line', () => {
    expect(blockedLines([line()])).toHaveLength(0);
  });
});
