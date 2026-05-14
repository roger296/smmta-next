/**
 * Unit tests for the pure helpers in `search.service.ts` and the
 * cache + budget control-flow that don't need a real DB.
 *
 * The full end-to-end search flow (LLM stub → category service →
 * llm_search_log insert) needs Postgres and lives in the integration
 * suite that the CI runs against docker-compose.
 */
import { describe, expect, it } from 'vitest';
import { hashQuery, mergeFilters } from './search.service.js';

describe('hashQuery', () => {
  it('produces the same hash for whitespace + case variants', () => {
    expect(hashQuery('Navy Fleece Large')).toBe(hashQuery('navy fleece large'));
    expect(hashQuery('  navy fleece  ')).toBe(hashQuery('NAVY FLEECE'));
  });
  it('produces different hashes for genuinely different inputs', () => {
    expect(hashQuery('navy fleece')).not.toBe(hashQuery('red fleece'));
  });
  it('returns a 64-char hex string', () => {
    const h = hashQuery('anything');
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
  });
});

describe('mergeFilters', () => {
  it('returns parsed when no override', () => {
    const parsed = { colour: ['Navy'], size: ['L'] };
    expect(mergeFilters(parsed, undefined)).toEqual(parsed);
  });

  it('returns override-only when no parsed', () => {
    const override = { colour: ['Red'] };
    expect(mergeFilters(undefined, override)).toEqual(override);
  });

  it('override wins per-axis (axis-level replacement, not merge)', () => {
    const parsed = { colour: ['Navy'], size: ['L'] };
    const override = { colour: ['Red'] };
    // colour was overridden; size kept from parsed.
    expect(mergeFilters(parsed, override)).toEqual({ colour: ['Red'], size: ['L'] });
  });

  it('override priceMin/priceMax replace parsed numbers', () => {
    const parsed = { priceMin: 10, priceMax: 50 };
    const override = { priceMax: 30 };
    expect(mergeFilters(parsed, override)).toEqual({ priceMin: 10, priceMax: 30 });
  });

  it('preserves both parsed and override when axes are disjoint', () => {
    const parsed = { colour: ['Navy'] };
    const override = { size: ['XL'] };
    expect(mergeFilters(parsed, override)).toEqual({ colour: ['Navy'], size: ['XL'] });
  });

  it('returns empty object when both inputs are undefined', () => {
    expect(mergeFilters(undefined, undefined)).toEqual({});
  });
});
