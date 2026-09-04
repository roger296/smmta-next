/**
 * Repair-script logic tests.
 *
 * The round-2 audit found "from 1 colours" still rendering on
 * production and asked a fair question: has the script not been run, or
 * is its match condition failing to catch that row? The single-colour
 * PLA Carbon Fibre range is the cleanest repro, so it's tested here
 * explicitly.
 *
 * These cover the two pure functions only. The database walk around
 * them is straightforward; the regexes are where a silent miss would
 * live, and "I reasoned it looked right" is not the same as knowing.
 */
import { describe, expect, it } from 'vitest';
import { DELIVERY_CLAIM, fixColourCount, fixDeliveryClaim } from './repair-seo-copy.js';

describe('fixColourCount', () => {
  it('fixes the exact string the audit found on PLA Carbon Fibre', () => {
    // Verbatim from the live site, quoted in the round-2 audit.
    const live =
      'Landau PLA Carbon Fibre 1.75mm 1kg from 1 colours. 1kg spools, fast UK delivery.';
    expect(fixColourCount(live, 'Black')).toBe(
      'Landau PLA Carbon Fibre 1.75mm 1kg in Black. 1kg spools, fast UK delivery.',
    );
  });

  it('falls back to "in one colour" when the colour is unknown', () => {
    expect(fixColourCount('X from 1 colours. Y', null)).toBe('X in one colour. Y');
  });

  it('leaves every other count alone', () => {
    for (const n of [2, 3, 5, 15, 23]) {
      const text = `A range from ${n} colours. B`;
      expect(fixColourCount(text, 'Black'), String(n)).toBe(text);
    }
  });

  it('is case-insensitive on the phrase', () => {
    expect(fixColourCount('From 1 Colours here', 'Red')).toBe('in Red here');
  });

  it('does not touch a correctly-worded single colour', () => {
    const already = 'Landau PLA Carbon Fibre 1.75mm 1kg in Black. 1kg spools.';
    expect(fixColourCount(already, 'Black')).toBe(already);
  });

  it('is idempotent — running twice changes nothing further', () => {
    const live = 'Landau PLA Carbon Fibre 1.75mm 1kg from 1 colours. 1kg spools.';
    const once = fixColourCount(live, 'Black');
    expect(fixColourCount(once, 'Black')).toBe(once);
  });
});

describe('fixDeliveryClaim', () => {
  it('fixes the exact variant description the audit quoted', () => {
    // The one that became crawlable when variant pages were de-noindexed.
    const live = 'Landau PLA 1.75mm 1kg in Green. 1kg spool, free UK delivery.';
    expect(fixDeliveryClaim(live)).toBe(
      'Landau PLA 1.75mm 1kg in Green. 1kg spool, fast UK delivery.',
    );
  });

  it('handles a capitalised claim', () => {
    expect(fixDeliveryClaim('Free UK delivery on everything.')).toBe(
      `${DELIVERY_CLAIM} on everything.`,
    );
  });

  it('leaves the correct claim untouched', () => {
    const already = '1kg spool, fast UK delivery.';
    expect(fixDeliveryClaim(already)).toBe(already);
  });

  it('is idempotent', () => {
    const live = '1kg spool, free UK delivery.';
    const once = fixDeliveryClaim(live);
    expect(fixDeliveryClaim(once)).toBe(once);
  });

  it('does not invent a claim where none exists', () => {
    const neutral = 'Landau PETG Pro 1.75mm 1kg — premium 3D printer filament.';
    expect(fixDeliveryClaim(neutral)).toBe(neutral);
  });
});

describe('the two fixes compose', () => {
  it('repairs a row carrying both problems at once', () => {
    const live = 'Landau PLA Carbon Fibre 1.75mm 1kg from 1 colours. 1kg spool, free UK delivery.';
    expect(fixColourCount(fixDeliveryClaim(live), 'Black')).toBe(
      'Landau PLA Carbon Fibre 1.75mm 1kg in Black. 1kg spool, fast UK delivery.',
    );
  });
});
