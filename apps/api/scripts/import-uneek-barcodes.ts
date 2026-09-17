/**
 * import-uneek-barcodes.ts — fill in barcodes, brand, weights and commodity
 * codes for Uneek products from the account's product-data CSV.
 *
 * Why a separate script: Uneek's `/productdata/all` API carries no EAN, no
 * weight and no commodity code, but the CSV behind "Website Data" in My Uneek
 * does (7,060 of 7,068 rows have a unique GTIN-13). Google Merchant Centre
 * needs a barcode plus a brand for clothing, so the catalogue import alone
 * isn't enough. Ask Uneek to add EAN to the API and this becomes redundant.
 *
 * Matching is on `products.stock_code` = the CSV's "Short Code", which is what
 * `import-uneek-products.ts` writes, so nothing is guessed.
 *
 * Usage (from repo root):
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/import-uneek-barcodes.ts \
 *     --csv=/path/TBV02-UneekProdData.csv --dry-run
 *
 * Flags:
 *   --csv=<path>   (required) the product-data CSV, as downloaded.
 *   --limit=<n>    Process at most n CSV rows (smoke test).
 *   --dry-run      Report what would change, write nothing.
 *   --help         This message.
 *
 * The file is Windows-1252, not UTF-8 (Uneek's export), so it is read as
 * latin1: mis-decoding it would corrupt accented characters.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { parse as csvParseSync } from 'csv-parse/sync';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

export interface UneekCsvIdentifiers {
  /** "Short Code" — matches products.stock_code. */
  stockCode: string;
  /** GTIN-13 barcode, or null when the row has none. */
  ean: string | null;
  /** "Company", e.g. "Uneek Clothing". */
  brand: string | null;
  /** "Gross Weight" in kg as a 3dp string, or null. */
  weightKg: string | null;
  /** "Commodity Code" — the customs tariff code. */
  hsCode: string | null;
}

/** A barcode we will store: digits only, at a GTIN length. Supplier files say
 *  things like "Not available" in this column, which must never be stored. */
export function normaliseEan(raw: string | undefined | null): string | null {
  const digits = (raw ?? '').trim().replace(/[\s-]+/g, '');
  if (!/^\d+$/.test(digits)) return null;
  return [8, 12, 13, 14].includes(digits.length) ? digits : null;
}

export function parseWeightKg(raw: string | undefined): string | null {
  const n = Number.parseFloat((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n.toFixed(3) : null;
}

export function normaliseCsvRow(row: Record<string, string>): UneekCsvIdentifiers | null {
  const stockCode = (row['Short Code'] ?? '').trim();
  if (!stockCode) return null;
  return {
    stockCode,
    ean: normaliseEan(row['EAN (Bar Code)']),
    brand: (row['Company'] ?? '').trim() || null,
    weightKg: parseWeightKg(row['Gross Weight']),
    hsCode: (row['Commodity Code'] ?? '').trim() || null,
  };
}

/** Rows keyed by stock code; the CSV holds one row per SKU. */
export function readIdentifiers(
  csvText: string,
  limit: number | null,
): Map<string, UneekCsvIdentifiers> {
  const rows = csvParseSync(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
  }) as Array<Record<string, string>>;
  const out = new Map<string, UneekCsvIdentifiers>();
  for (const row of rows) {
    if (limit !== null && out.size >= limit) break;
    const parsed = normaliseCsvRow(row);
    if (parsed) out.set(parsed.stockCode, parsed);
  }
  return out;
}

interface CliOpts {
  csvPath: string;
  limit: number | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  let csvPath = '';
  let limit: number | null = null;
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx import-uneek-barcodes.ts --csv=<path> [--limit=n] [--dry-run]');
      process.exit(0);
    } else if (arg.startsWith('--csv=')) {
      csvPath = arg.slice('--csv='.length).trim();
    } else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`bad --limit value: ${arg}`);
        process.exit(2);
      }
      limit = Math.floor(n);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('-')) {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  if (!csvPath) {
    console.error('--csv=<path to the Uneek product-data CSV> is required');
    process.exit(2);
  }
  return { csvPath, limit, dryRun };
}

const CHUNK = 500;

async function main() {
  const opts = parseArgs(process.argv);
  const companyId = getSingletonCompanyId();
  const db = getDb();

  const text = fs.readFileSync(opts.csvPath, 'latin1');
  const identifiers = readIdentifiers(text, opts.limit);
  const withEan = [...identifiers.values()].filter((r) => r.ean).length;
  console.log(`[uneek-barcodes] read ${identifiers.size} rows from ${opts.csvPath}`);
  console.log(`[uneek-barcodes] ${withEan} of them carry a barcode.`);

  const codes = [...identifiers.keys()];
  let matched = 0;
  let updated = 0;
  let unchanged = 0;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const chunk = codes.slice(i, i + CHUNK);
    const rows = await db
      .select({
        id: products.id,
        stockCode: products.stockCode,
        ean: products.ean,
        brand: products.brand,
        weight: products.weight,
        hsCode: products.hsCode,
      })
      .from(products)
      .where(
        and(
          eq(products.companyId, companyId),
          isNull(products.deletedAt),
          inArray(products.stockCode, chunk),
        ),
      );
    for (const row of rows) {
      const wanted = row.stockCode ? identifiers.get(row.stockCode) : undefined;
      if (!wanted) continue;
      matched++;
      // Only write what is missing or different; the catalogue importer owns
      // everything else about the product.
      const patch: Record<string, string> = {};
      if (wanted.ean && wanted.ean !== row.ean) patch.ean = wanted.ean;
      if (wanted.brand && wanted.brand !== row.brand) patch.brand = wanted.brand;
      if (wanted.weightKg && wanted.weightKg !== row.weight) patch.weight = wanted.weightKg;
      if (wanted.hsCode && wanted.hsCode !== row.hsCode) patch.hsCode = wanted.hsCode;
      if (Object.keys(patch).length === 0) {
        unchanged++;
        continue;
      }
      updated++;
      if (!opts.dryRun) {
        await db
          .update(products)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(products.id, row.id));
      }
    }
  }

  const unmatched = identifiers.size - matched;
  console.log('');
  console.log(opts.dryRun ? '=== DRY RUN — nothing written ===' : '=== Done ===');
  console.log(`  CSV rows            ${identifiers.size}`);
  console.log(`  matched products    ${matched}`);
  console.log(`  ${opts.dryRun ? 'would update' : 'updated     '}        ${updated}`);
  console.log(`  already correct     ${unchanged}`);
  console.log(`  no product matched  ${unmatched}`);
}

// Only run when invoked directly, so the helpers above stay unit-testable.
if (process.argv[1]?.endsWith('import-uneek-barcodes.ts')) {
  main()
    .catch((err) => {
      console.error('[uneek-barcodes] FATAL:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void closeDatabase();
    });
}
