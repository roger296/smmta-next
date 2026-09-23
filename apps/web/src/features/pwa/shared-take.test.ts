/**
 * Several counters, one take — the rules for what each row shows and whose
 * number it is. See shared-take.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  attribution,
  conflicts,
  countersOn,
  rowCount,
  settleQueued,
  type SharedLine,
} from './shared-take';

const ME = 'pin:me';
const line = (over: Partial<SharedLine> = {}): SharedLine => ({ productId: 'p1', ...over });
const samSaved = line({ countedQty: '12.000', countedByUserId: 'pin:sam', countedByName: 'Sam', countedAt: '2026-09-23T09:42:00Z' });

describe('rowCount: which number a row shows', () => {
  it('an untouched line is not counted', () => {
    expect(rowCount(line(), {}, {}, ME)).toEqual({ counted: false, qty: 0, source: 'none' });
  });

  it("shows someone else's saved count, with their name", () => {
    const r = rowCount(samSaved, {}, {}, ME);
    expect(r).toMatchObject({ counted: true, qty: 12, source: 'saved', byName: 'Sam', mine: false });
  });

  it('recognises my own saved count as mine', () => {
    const r = rowCount({ ...samSaved, countedByUserId: ME }, {}, {}, ME);
    expect(r.mine).toBe(true);
  });

  it('what I have typed here wins over what is saved, then what is queued', () => {
    expect(rowCount(samSaved, { p1: 10 }, { p1: 11 }, ME)).toMatchObject({ qty: 10, source: 'pending' });
    expect(rowCount(samSaved, {}, { p1: 11 }, ME)).toMatchObject({ qty: 11, source: 'queued' });
  });

  it('a saved zero is a count, not a blank', () => {
    expect(rowCount(line({ countedQty: '0.000', countedByName: 'Sam' }), {}, {}, ME)).toMatchObject({ counted: true, qty: 0 });
  });
});

describe('attribution: the line that says whose number it is', () => {
  it('names the other counter and the time', () => {
    const text = attribution(rowCount(samSaved, {}, {}, ME))!;
    expect(text).toMatch(/^Saved by Sam · \d\d:\d\d$/);
  });

  it('says "you" for my own count', () => {
    expect(attribution(rowCount({ ...samSaved, countedByUserId: ME }, {}, {}, ME))).toMatch(/^Saved by you/);
  });

  it('says a count predates names rather than inventing a counter', () => {
    expect(attribution(rowCount(line({ countedQty: '3' }), {}, {}, ME))).toBe('Saved by someone (not recorded)');
  });

  it('labels unsaved and queued counts so they are never mistaken for saved ones', () => {
    expect(attribution(rowCount(line(), { p1: 1 }, {}, ME))).toBe('Not saved yet');
    expect(attribution(rowCount(line(), {}, { p1: 1 }, ME))).toBe('Waiting to send');
    expect(attribution(rowCount(line(), {}, {}, ME))).toBeNull();
  });
});

describe("conflicts: saving over someone else's number", () => {
  it("finds a different number over someone else's count", () => {
    expect(conflicts([samSaved], { p1: 10 }, ME)).toEqual([
      { productId: 'p1', theirName: 'Sam', theirQty: 12, yourQty: 10 },
    ]);
  });

  it('the same number is not a conflict — nothing is lost', () => {
    expect(conflicts([samSaved], { p1: 12 }, ME)).toEqual([]);
  });

  it('replacing my own earlier count is not a conflict', () => {
    expect(conflicts([{ ...samSaved, countedByUserId: ME }], { p1: 10 }, ME)).toEqual([]);
  });

  it('an uncounted line, or a line I did not touch, is not a conflict', () => {
    expect(conflicts([line()], { p1: 10 }, ME)).toEqual([]);
    expect(conflicts([samSaved], {}, ME)).toEqual([]);
  });
});

describe('settleQueued: queued counts that have now synced', () => {
  it('drops a queued count once the server shows it saved by me with that number', () => {
    const synced = { ...samSaved, countedQty: '5', countedByUserId: ME };
    expect(settleQueued({ p1: 5 }, [synced], ME)).toEqual({});
  });

  it("keeps it while the server still shows someone else's number", () => {
    const q = { p1: 5 };
    expect(settleQueued(q, [samSaved], ME)).toBe(q);
  });
});

describe('countersOn: who is counting this take', () => {
  it('tallies lines per counter, most first, and calls mine "You"', () => {
    const lines: SharedLine[] = [
      { productId: 'a', countedQty: '1', countedByUserId: 'pin:sam', countedByName: 'Sam' },
      { productId: 'b', countedQty: '1', countedByUserId: 'pin:sam', countedByName: 'Sam' },
      { productId: 'c', countedQty: '1', countedByUserId: ME, countedByName: 'Me' },
      { productId: 'd' },
    ];
    expect(countersOn(lines, ME)).toEqual([
      { name: 'Sam', lines: 2, mine: false },
      { name: 'You', lines: 1, mine: true },
    ]);
  });
});
