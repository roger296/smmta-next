import { describe, expect, it } from 'vitest';
import { countInstruction, uomFullName } from './count-instruction';

describe('uomFullName', () => {
  it.each([
    ['kg', 'kilograms'],
    ['g', 'grams'],
    ['l', 'litres'],
    ['ml', 'millilitres'],
    ['bottle', 'bottles'],
    ['pack', 'packs'],
    ['each', 'single units'],
  ])('spells "%s" out as "%s"', (uom, expected) => {
    expect(uomFullName(uom)).toBe(expected);
  });

  it('is case- and whitespace-insensitive, because the catalogue is hand-typed', () => {
    expect(uomFullName(' KG ')).toBe('kilograms');
  });

  it('falls back to the unit itself when it has no long name', () => {
    expect(uomFullName('firkin')).toBe('firkin');
  });

  it('returns null for a missing unit rather than an empty string', () => {
    expect(uomFullName(null)).toBeNull();
    expect(uomFullName('')).toBeNull();
    expect(uomFullName('   ')).toBeNull();
  });
});

describe('countInstruction', () => {
  it('builds the sentence from the stock unit when the product has no instruction', () => {
    expect(countInstruction(null, 'kg')).toBe('Count this item in kilograms');
    expect(countInstruction(undefined, 'bottle')).toBe('Count this item in bottles');
  });

  // The operator wrote it BECAUSE the generic sentence was not enough.
  it('shows the product instruction instead whenever one is set', () => {
    expect(countInstruction('Weigh, do not count', 'kg')).toBe('Weigh, do not count');
  });

  it('treats a whitespace-only instruction as unset', () => {
    expect(countInstruction('   ', 'kg')).toBe('Count this item in kilograms');
  });

  it('trims a stored instruction', () => {
    expect(countInstruction('  Check the date on the box  ', 'kg')).toBe(
      'Check the date on the box',
    );
  });

  // "Count this item in " with nothing after it is worse than no message.
  it('says nothing when there is no instruction AND no unit', () => {
    expect(countInstruction(null, null)).toBeNull();
    expect(countInstruction(null, '')).toBeNull();
  });

  it('still shows the instruction when the unit is unknown', () => {
    expect(countInstruction('Count the crates on the top shelf', null)).toBe(
      'Count the crates on the top shelf',
    );
  });
});
