/**
 * "What's left" mode turns a remaining quantity into a consumed one by
 * subtracting from stock we believe is there. Every way that can go wrong ends
 * with a consumption movement, so the refusals matter more than the happy path:
 * a wrong number here silently moves stock and feeds the materials cost, where
 * nobody would ever look for it.
 */
import { describe, expect, it } from 'vitest';
import { derivedActualQty, ConsumptionEntryError } from './session-consumption.service.js';

describe('derivedActualQty', () => {
  it('subtracts what is left from what was there', () => {
    expect(derivedActualQty(20, 16)).toBe(4);
  });

  it('reports nothing used when the tub is untouched', () => {
    expect(derivedActualQty(20, 20)).toBe(0);
  });

  it('reports everything used when the tub is empty', () => {
    expect(derivedActualQty(2.5, 0)).toBe(2.5);
  });

  it('rounds to the 3dp the column stores, not to a float artefact', () => {
    // 0.3 - 0.1 is 0.19999999999999998 in IEEE754; the column is numeric(18,3).
    expect(derivedActualQty(0.3, 0.1)).toBe(0.2);
    expect(derivedActualQty(10.0005, 0)).toBe(10.001);
  });

  it('is the exact inverse of counting up', () => {
    const opening = 12.75;
    const used = 3.25;
    expect(derivedActualQty(opening, opening - used)).toBe(used);
  });
});

describe('ConsumptionEntryError', () => {
  it('carries the product so the form can mark the offending line', () => {
    const err = new ConsumptionEntryError('prod-1', 'nope');
    expect(err.productId).toBe('prod-1');
    expect(err.name).toBe('ConsumptionEntryError');
    expect(err).toBeInstanceOf(Error);
  });
});

/**
 * The F12 client rewrite changed how a REMAINING line is ENTERED, not how it
 * is interpreted (Aug-2026 feedback set). This is the assertion that the
 * server side is untouched: the derivation is still opening − remaining, so
 * the direction fix and the non-destructive toggle cannot have moved the
 * meaning of the number that arrives.
 */
describe('F12: the server-side derivation is unchanged', () => {
  it('still derives usage from opening stock, not from anything the form guessed', () => {
    // The exact shape the venue screen now sends: the baker answered "what's
    // left" with 300 g against an opening of 500 g.
    expect(derivedActualQty(500, 300)).toBe(200);
  });

  it('an explicit "nothing left" is still a full usage, not a missing answer', () => {
    // The client distinguishes "left nothing" from "did not count" (F-8's
    // guard); by the time it reaches here, 0 means the shelf really is empty.
    expect(derivedActualQty(500, 0)).toBe(500);
  });

  it('is still a pure subtraction — the refusals live in the caller, not here', () => {
    // `resolveRemainingLine` is what rejects a negative remaining, a missing
    // one, an unknown opening, and "more left than we think was there". This
    // helper deliberately stays arithmetic, and the F12 client changes did not
    // move that boundary.
    expect(derivedActualQty(1, 5)).toBe(-4);
  });
});
