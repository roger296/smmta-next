/**
 * The two properties that matter for head-baker PINs:
 *
 *  - they must be DISTINCT across sites, because `POST /auth/pin-login` treats
 *    siteId as optional and takes the first PIN whose hash verifies. A shared
 *    PIN would file a baker's counts against an arbitrary site, silently;
 *  - seeding must be idempotent, because re-running it must never mint a
 *    second PIN for a site or invalidate one already handed to staff.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../src/config/database.js';
import { seedSites } from './seed-sites.js';
import { envKeyFor, labelFor, seedHeadBakerPins } from './seed-head-baker-pins.js';

describe('labelFor', () => {
  it('names the site, not a person — these are placeholders', () => {
    expect(labelFor('London East')).toBe('London East Head Baker');
  });
});

describe('envKeyFor', () => {
  it('makes a usable env key from a spaced site name', () => {
    expect(envKeyFor('London East')).toBe('HEAD_BAKER_PIN_LONDON_EAST');
    expect(envKeyFor('Manchester')).toBe('HEAD_BAKER_PIN_MANCHESTER');
  });
});

describe('seedHeadBakerPins', () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it('proposes one distinct PIN per site and writes nothing on a dry run', async () => {
    await seedSites();
    const first = await seedHeadBakerPins({ dryRun: true });
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((r) => r.status === 'would-create' || r.status === 'exists')).toBe(true);

    const pins = first.filter((r) => r.pin).map((r) => r.pin!);
    // The whole point — a duplicate here is a wrong-site data leak.
    expect(new Set(pins).size).toBe(pins.length);
    for (const pin of pins) expect(pin).toMatch(/^[1-9]\d{5}$/);

    // Nothing was written, so a second dry run still has everything to do.
    const second = await seedHeadBakerPins({ dryRun: true });
    expect(second.filter((r) => r.status === 'would-create').length).toBe(
      first.filter((r) => r.status === 'would-create').length,
    );
  });

  it('is idempotent — a second run leaves existing PINs untouched', async () => {
    await seedSites();
    await seedHeadBakerPins();
    const again = await seedHeadBakerPins();
    expect(again.length).toBeGreaterThan(0);
    expect(again.every((r) => r.status === 'exists')).toBe(true);
    // An existing PIN's value is a hash — it must never be echoed back.
    expect(again.every((r) => r.pin === undefined)).toBe(true);
  });
});
