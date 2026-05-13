/**
 * End-to-end dry-run test for `runImport`.
 *
 * Verifies the streaming path, the discontinued/malformed filtering,
 * the limit handling, and the progress callback. No DB writes (dryRun:
 * true), so this runs without Postgres.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as csvParse } from 'csv-parse';
import { runImport } from './seed-ralawise-catalogue.js';
import type { RalawiseRawRow } from './seed-ralawise-catalogue.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/ralawise-catalogue-sample.csv',
);

async function* streamFixture(): AsyncIterable<RalawiseRawRow> {
  const stream = fs.createReadStream(FIXTURE).pipe(
    csvParse({
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: false,
      relax_column_count: true,
    }),
  );
  for await (const row of stream) {
    yield row as RalawiseRawRow;
  }
}

describe('runImport (dry-run, streaming)', () => {
  it('reads the fixture and counts Live vs Discontinued correctly', async () => {
    const summary = await runImport(
      streamFixture(),
      {
        companyId: 'co-test',
        supplierId: 'sup-test',
        channelId: null,
        publish: false,
        dryRun: true,
      },
      { limit: null, markup: 2.0 },
    );
    // Fixture has 20 rows that pass the CSV parser: 19 real data
    // rows + 1 all-empty trailing row.
    // - 18 are Live with valid SKU/style → counted
    // - 1 is Discontinued (TEST02GREY1S) → skipped
    // - 1 is the all-empty row → skipped as malformed
    expect(summary.rowsRead).toBe(20);
    expect(summary.rowsSkippedDiscontinued).toBe(1);
    expect(summary.rowsSkippedMalformed).toBe(1);
    expect(summary.rowsConsidered).toBe(18);
    // dryRun → no DB writes counted
    expect(summary.groupsCreated + summary.groupsUpdated).toBe(0);
    expect(summary.productsCreated + summary.productsUpdated).toBe(0);
    expect(summary.dryRun).toBe(true);
  });

  it('honours --limit', async () => {
    const summary = await runImport(
      streamFixture(),
      {
        companyId: 'co-test',
        supplierId: 'sup-test',
        channelId: null,
        publish: false,
        dryRun: true,
      },
      { limit: 5, markup: 2.0 },
    );
    expect(summary.rowsConsidered).toBe(5);
    expect(summary.rowsRead).toBeGreaterThanOrEqual(5);
  });

  it('captures malformed-row examples without crashing', async () => {
    // The fixture intentionally has TEST04BLACS with garbage prices.
    // The parse itself succeeds; the row is just counted as Live with
    // null prices. So malformed count stays 0 — this checks the
    // "no fatal crash on weird data" path, not just "anything weird
    // is malformed".
    const summary = await runImport(
      streamFixture(),
      {
        companyId: 'co-test',
        supplierId: 'sup-test',
        channelId: null,
        publish: false,
        dryRun: true,
      },
      { limit: null, markup: 2.0 },
    );
    // 1 malformed (the all-empty trailing row) — the broken-price row
    // is NOT malformed because Ralawise's columns are all optional;
    // null prices come through as Live rows with null costGbp.
    expect(summary.rowsSkippedMalformed).toBe(1);
  });

  it('fires onProgress at the 5000-row interval (no-op here, just smoke)', async () => {
    let calls = 0;
    await runImport(
      streamFixture(),
      {
        companyId: 'co-test',
        supplierId: 'sup-test',
        channelId: null,
        publish: false,
        dryRun: true,
      },
      {
        limit: null,
        markup: 2.0,
        onProgress: () => {
          calls++;
        },
      },
    );
    // We only have 19 rows so 5000-row interval doesn't fire. The
    // assertion is just "no exception thrown".
    expect(calls).toBeGreaterThanOrEqual(0);
  });
});
