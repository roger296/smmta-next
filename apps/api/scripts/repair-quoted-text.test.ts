/**
 * Unit tests for the pure helpers in `repair-quoted-text.ts`. The DB walk
 * itself is a plain select-and-update over rows the SQL filter already
 * narrowed, so the interesting logic is which fields get rewritten.
 */
import { describe, expect, it } from 'vitest';
import { buildPatch, repairSegments, repairedOrNull } from './repair-quoted-text.js';

describe('repairSegments', () => {
  it("repairs a variant name, where the closing quote sits mid-value", () => {
    expect(repairSegments('"Hamblin 22" traveller" · Black · OS')).toBe(
      'Hamblin 22" traveller · Black · OS',
    );
  });

  it('repairs a range name, which has no segments', () => {
    expect(repairSegments('"Essential 13" laptop case"')).toBe('Essential 13" laptop case');
  });

  it('leaves the colour and size alone', () => {
    expect(repairSegments('Classic hoodie · Navy · XL')).toBe('Classic hoodie · Navy · XL');
  });
});

describe('repairedOrNull', () => {
  it('returns the repaired value only when it differs', () => {
    expect(repairedOrNull('"Hamblin 22" traveller"')).toBe('Hamblin 22" traveller');
    expect(repairedOrNull('"Hamblin 22" traveller" · Black · OS')).toBe(
      'Hamblin 22" traveller · Black · OS',
    );
    expect(repairedOrNull('Classic hoodie')).toBeNull();
  });

  it('leaves null and empty alone, so a NULL never becomes an empty string', () => {
    expect(repairedOrNull(null)).toBeNull();
    expect(repairedOrNull('')).toBeNull();
  });
});

describe('buildPatch', () => {
  it('patches only the fields the repair changes', () => {
    const row = {
      name: '"Essential 13" laptop case"',
      description: 'A padded case for a 13" laptop.',
      colour: 'Black',
      brand: null,
    };
    expect(buildPatch(row, ['name', 'description', 'colour', 'brand'])).toEqual({
      name: 'Essential 13" laptop case',
    });
  });

  it('is empty for a row that is already clean, so the walk skips it', () => {
    const row = { name: 'Classic hoodie', description: null };
    expect(buildPatch(row, ['name', 'description'])).toEqual({});
  });
});
