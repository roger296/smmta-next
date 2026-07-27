/**
 * The count-line key is the one thing here that fails silently if it is wrong.
 *
 * 23 items are counted in two places — every fondant colour sits in both
 * General Ingredients and Creation Corner, Mint in both Creation Corner and Bar
 * Stock. If the key were product-scoped, the second location's count would
 * overwrite the first on sync, and the consolidation would never flag it,
 * because it only reports a conflict when two *devices* write the same key.
 */
import { describe, expect, it } from 'vitest';
import { countLineKey } from './catalogue.service.js';

describe('countLineKey', () => {
  it('reproduces the key the bundled catalogue used', () => {
    // The old build's key for the first row of the June sheet.
    expect(countLineKey('DRY STOCK', 'Caster Sugar')).toBe('dry-stock-caster-sugar');
  });

  it('keeps one product distinct across the two sections it is counted in', () => {
    const general = countLineKey('FONDANT', 'White Fondant');
    const creationCorner = countLineKey('Fondant', 'White Fondant');
    // Same product, same section NAME but different case — these two really are
    // the same count line, and must collapse.
    expect(general).toBe(creationCorner);

    // Whereas genuinely different sections must not.
    expect(countLineKey('Sandwich Fillings', 'Beef Tomato')).not.toBe(
      countLineKey('BAR FOOD', 'Beef Tomato'),
    );
  });

  it('survives punctuation and spacing in section names', () => {
    expect(countLineKey("EXTRA'S - Cocktail Mix Ingredients", 'Agave Nectar')).toBe(
      'extra-s-cocktail-mix-ingredients-agave-nectar',
    );
  });

  it('handles a missing section without producing a leading separator collision', () => {
    expect(countLineKey(null, 'Caster Sugar')).toBe('-caster-sugar');
    expect(countLineKey(null, 'Caster Sugar')).not.toBe(countLineKey('', 'Caster Sugar2'));
  });
});
