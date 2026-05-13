/**
 * Unit tests for the pure helpers in `seed-ralawise-catalogue.ts`.
 *
 * The DB-side `runImport` / `applyBatch` need a real Postgres to test
 * end-to-end and live in the integration suite (which runs against
 * `docker-compose up postgres` locally and against the CI Postgres
 * service). These tests cover the field-by-field parsing logic that
 * doesn't need a transaction.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as csvParse } from 'csv-parse/sync';
import {
  applyMarkup,
  normaliseRow,
  parseDecimal,
  parseLicenceExpiry,
  pickHeroImage,
  rgbToHex,
  slugify,
  topLevelCategory,
} from './seed-ralawise-catalogue.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/ralawise-catalogue-sample.csv',
);

describe('slugify', () => {
  it('lowercases + dashes', () => {
    expect(slugify('TS004')).toBe('ts004');
  });
  it('handles spaces + punctuation', () => {
    expect(slugify('UC 940-XL!')).toBe('uc-940-xl');
  });
  it('falls back to "item" for empty input', () => {
    expect(slugify('')).toBe('item');
    expect(slugify('---')).toBe('item');
  });
});

describe('parseDecimal', () => {
  it('parses plain decimal', () => {
    expect(parseDecimal('21.25')).toBe(21.25);
  });
  it('strips currency symbols + commas', () => {
    expect(parseDecimal('£1,234.50')).toBe(1234.5);
  });
  it('returns null for empty / non-numeric', () => {
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('   ')).toBeNull();
    expect(parseDecimal('not-a-number')).toBeNull();
    expect(parseDecimal(null)).toBeNull();
    expect(parseDecimal(undefined)).toBeNull();
  });
});

describe('applyMarkup', () => {
  it('applies markup and 2dp rounding', () => {
    expect(applyMarkup(21.25, 2.0)).toBe('42.50');
    expect(applyMarkup(7.95, 2.5)).toBe('19.88'); // 19.875 → 19.88
  });
  it('returns null for null/zero/negative cost', () => {
    expect(applyMarkup(null, 2.0)).toBeNull();
    expect(applyMarkup(0, 2.0)).toBeNull();
    expect(applyMarkup(-1, 2.0)).toBeNull();
  });
  it('returns null for non-positive markup', () => {
    expect(applyMarkup(10, 0)).toBeNull();
    expect(applyMarkup(10, NaN)).toBeNull();
  });
});

describe('parseLicenceExpiry', () => {
  it('parses Ralawise CSV format with a space separator', () => {
    const d = parseLicenceExpiry('2026-12-31 00:00:00');
    expect(d).toBeInstanceOf(Date);
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(11);
    expect(d!.getUTCDate()).toBe(31);
  });
  it('parses ISO with T separator too', () => {
    const d = parseLicenceExpiry('2026-12-31T00:00:00');
    expect(d).not.toBeNull();
  });
  it('returns null for empty / unparseable', () => {
    expect(parseLicenceExpiry('')).toBeNull();
    expect(parseLicenceExpiry(null)).toBeNull();
    expect(parseLicenceExpiry('not a date')).toBeNull();
  });
});

describe('rgbToHex', () => {
  it('converts space-separated RGB triple', () => {
    expect(rgbToHex('51 51 51')).toBe('#333333');
    expect(rgbToHex('255 255 255')).toBe('#FFFFFF');
    expect(rgbToHex('0 0 0')).toBe('#000000');
  });
  it('handles multi-space separators', () => {
    expect(rgbToHex('  51   51   51  ')).toBe('#333333');
  });
  it('returns null on bad input', () => {
    expect(rgbToHex('')).toBeNull();
    expect(rgbToHex('51 51')).toBeNull(); // only 2 components
    expect(rgbToHex('300 0 0')).toBeNull(); // out of range
    expect(rgbToHex('a b c')).toBeNull();
    expect(rgbToHex(null)).toBeNull();
  });
});

describe('topLevelCategory', () => {
  it('returns the first pipe-segment', () => {
    expect(topLevelCategory('Jackets & Coats|Organic & Conscious|Gilets')).toBe('Jackets & Coats');
  });
  it('returns the whole string when no pipe', () => {
    expect(topLevelCategory('T-Shirts')).toBe('T-Shirts');
  });
  it('returns null on empty', () => {
    expect(topLevelCategory('')).toBeNull();
    expect(topLevelCategory(null)).toBeNull();
  });
});

describe('pickHeroImage', () => {
  const blank = {
    'Colour Image': '',
    'Primary Product Image URL': '',
  };
  it('prefers colour image when set', () => {
    expect(pickHeroImage({ ...blank, 'Colour Image': 'A', 'Primary Product Image URL': 'B' })).toBe('A');
  });
  it('falls back to primary product image when colour empty', () => {
    expect(pickHeroImage({ ...blank, 'Primary Product Image URL': 'B' })).toBe('B');
  });
  it('returns null when both empty', () => {
    expect(pickHeroImage(blank)).toBeNull();
  });
});

describe('normaliseRow (against the fixture CSV)', () => {
  // Parse the fixture once with csv-parse/sync (test-only sync path
  // is fine because the file is small).
  const rows = csvParse(fs.readFileSync(FIXTURE, 'utf8'), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: false,
    relax_column_count: true,
  }) as Array<Record<string, string>>;

  it('parses all 20-ish fixture rows (including the empty trailing row)', () => {
    expect(rows.length).toBeGreaterThanOrEqual(19);
  });

  it('first row: TEST01 black S — full happy path', () => {
    const r = normaliseRow(rows[0]!, 2.0);
    expect(r.skuCode).toBe('TEST01BLACS');
    expect(r.styleCode).toBe('TEST01');
    expect(r.styleName).toBe('Demo hooded bodywarmer');
    expect(r.colourCode).toBe('BLAC');
    expect(r.colourName).toBe('Black');
    expect(r.sizeCode).toBe('S');
    expect(r.costGbp).toBe(21.25);
    expect(r.retailGbp).toBe('42.50');
    expect(r.colourHex).toBe('#333333');
    expect(r.category).toBe('Jackets & Coats');
    expect(r.imageLicenceExpiresAt).toBeInstanceOf(Date);
    expect(r.imageLicenceExpiresAt!.getUTCFullYear()).toBe(2026);
    expect(r.heroImageUrl).toBe('https://cdn.pimber.ly/test/TEST01_BLAC.jpg');
    expect(r.groupHeroImageUrl).toBe('https://cdn.pimber.ly/test/TEST01_primary.jpg');
    expect(r.skuStatus).toBe('Live');
  });

  it('discontinued row keeps skuStatus = "Discontinued" so caller can filter', () => {
    const discontinued = rows.find((r) => r['Sku Code'] === 'TEST02GREY1S')!;
    const norm = normaliseRow(discontinued, 2.0);
    expect(norm.skuStatus).toBe('Discontinued');
  });

  it('row with broken price has costGbp=null and retailGbp=null', () => {
    const broken = rows.find((r) => r['Sku Code'] === 'TEST04BLACS')!;
    const norm = normaliseRow(broken, 2.0);
    expect(norm.costGbp).toBeNull();
    expect(norm.retailGbp).toBeNull();
  });

  it('row with no primary URL falls back gracefully (uses colour image only)', () => {
    const r = rows.find((row) => row['Sku Code'] === 'TEST03BLACS')!;
    const norm = normaliseRow(r, 2.0);
    expect(norm.groupHeroImageUrl).toBeNull(); // primary URL was empty
    expect(norm.heroImageUrl).toBeNull(); // colour image was also empty for this row
  });

  it('markup propagates correctly through normaliseRow', () => {
    const r = rows[0]!;
    expect(normaliseRow(r, 2.0).retailGbp).toBe('42.50');
    expect(normaliseRow(r, 3.0).retailGbp).toBe('63.75');
    expect(normaliseRow(r, 1.5).retailGbp).toBe('31.88'); // 31.875 → 31.88
  });
});
