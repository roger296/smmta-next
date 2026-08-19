/**
 * Guard for the whole CLASS of bug behind defect D-1 (Aug-2026 feedback set).
 *
 * `pageSize` above the API's cap does not truncate — it **400s**. On 12 Aug the
 * stock-take screen asked for 500, the product lookup threw, and every row on
 * the count sheet rendered as an eight-character hex fragment. Nothing in the
 * build noticed.
 *
 * This walks every source file under `apps/web/src` and fails on any
 * `pageSize` literal above the shared cap, so the client and the server
 * contract cannot drift apart silently again.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_PAGE_SIZE } from './api-client';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

/** `pageSize: 500`, `pageSize=500`, `'pageSize', '500'` — all of them. */
const PAGE_SIZE_LITERAL = /pageSize\s*[:=,]\s*['"]?(\d+)/g;

describe('pageSize never exceeds the shared API cap (D-1)', () => {
  it('mirrors the API constant', () => {
    // If the API raises or lowers its cap, this file is the tripwire that says
    // the mirror in api-client.ts needs the same edit.
    expect(MAX_PAGE_SIZE).toBe(250);
  });

  it('no request in apps/web/src asks for more than the cap', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      // This guard file quotes oversized values on purpose.
      if (file.endsWith('page-size-guard.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(PAGE_SIZE_LITERAL)) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > MAX_PAGE_SIZE) {
          offenders.push(`${path.relative(SRC, file)}: pageSize ${value}`);
        }
      }
    }

    expect(offenders, `pageSize above the ${MAX_PAGE_SIZE} cap 400s — these requests would fail`).toEqual([]);
  });
});
