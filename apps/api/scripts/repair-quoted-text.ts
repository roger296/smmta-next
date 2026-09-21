/**
 * repair-quoted-text.ts — strip the stray quotes the Ralawise import left
 * on product and range text.
 *
 * Ralawise's CSV doesn't double the inches mark inside a quoted field, so
 * `csv-parse` (running with `relax_quotes`) handed back the raw text of
 * those fields, outer quotes and all. The result reached customers: the
 * Clothes Shop showed `"Hamblin 22" traveller"` as a page title, and the
 * same text went into the Google Merchant Centre feed.
 *
 * The importer no longer does this (`repairRelaxedQuotes` in
 * `seed-ralawise-catalogue.ts`), and re-importing would fix the rows it
 * touches — but a full Ralawise import is a ~30-minute job that rewrites
 * prices and stock, which is far more than this needs. This script fixes
 * only the text, on both suppliers' products, and is idempotent: a second
 * run finds nothing to do.
 *
 * Usage (from repo root):
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/repair-quoted-text.ts --dry-run
 *   DATABASE_URL=... npx tsx apps/api/scripts/repair-quoted-text.ts
 *
 * Flags:
 *   --dry-run   Report what would change, write nothing.
 *   --help      This message.
 */
import 'dotenv/config';
import { and, eq, isNull, or, like, type SQL } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { productGroups, products } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { repairRelaxedQuotes } from './seed-ralawise-catalogue.js';

/** A value worth rewriting: one the repair actually changes. `null` and
 *  empty stay as they are, so the script never turns a NULL into ''. */
export function repairedOrNull(value: string | null): string | null {
  if (value === null || value === '') return null;
  const fixed = repairRelaxedQuotes(value);
  return fixed === value ? null : fixed;
}

/** The patch for one row: only the fields the repair changes. */
export function buildPatch<T extends Record<string, string | null>>(
  row: T,
  fields: Array<keyof T & string>,
): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const field of fields) {
    const fixed = repairedOrNull(row[field]);
    if (fixed !== null) patch[field] = fixed;
  }
  return patch;
}

/** Wrapped in quotes at both ends — the signature of the relaxed parse.
 *  Doing this in SQL keeps us from reading 100k rows to change a few. */
function quotedAtBothEnds(columns: SQL[]): SQL {
  return or(...columns)!;
}

const PRODUCT_FIELDS = ['name', 'description', 'shortDescription', 'seoDescription', 'colour', 'brand'] as const;
const GROUP_FIELDS = ['name', 'description', 'shortDescription', 'seoDescription'] as const;

interface CliOpts {
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  let dryRun = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx repair-quoted-text.ts [--dry-run]');
      process.exit(0);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('-')) {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return { dryRun };
}

async function main() {
  const opts = parseArgs(process.argv);
  const companyId = getSingletonCompanyId();
  const db = getDb();

  const samples: string[] = [];
  let productsFixed = 0;
  let groupsFixed = 0;

  const productRows = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      shortDescription: products.shortDescription,
      seoDescription: products.seoDescription,
      colour: products.colour,
      brand: products.brand,
    })
    .from(products)
    .where(
      and(
        eq(products.companyId, companyId),
        isNull(products.deletedAt),
        quotedAtBothEnds(PRODUCT_FIELDS.map((f) => like(products[f], '"%"'))),
      ),
    );
  console.log(`[repair-quotes] ${productRows.length} products look quoted.`);

  for (const row of productRows) {
    const patch = buildPatch(row, [...PRODUCT_FIELDS]);
    if (Object.keys(patch).length === 0) continue;
    productsFixed++;
    if (samples.length < 10 && patch.name) samples.push(`${row.name}  →  ${patch.name}`);
    if (!opts.dryRun) {
      await db
        .update(products)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(products.id, row.id));
    }
  }

  const groupRows = await db
    .select({
      id: productGroups.id,
      name: productGroups.name,
      description: productGroups.description,
      shortDescription: productGroups.shortDescription,
      seoDescription: productGroups.seoDescription,
    })
    .from(productGroups)
    .where(
      and(
        eq(productGroups.companyId, companyId),
        quotedAtBothEnds(GROUP_FIELDS.map((f) => like(productGroups[f], '"%"'))),
      ),
    );
  console.log(`[repair-quotes] ${groupRows.length} ranges look quoted.`);

  for (const row of groupRows) {
    const patch = buildPatch(row, [...GROUP_FIELDS]);
    if (Object.keys(patch).length === 0) continue;
    groupsFixed++;
    if (samples.length < 10 && patch.name) samples.push(`${row.name}  →  ${patch.name}`);
    if (!opts.dryRun) {
      await db
        .update(productGroups)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(productGroups.id, row.id));
    }
  }

  console.log('');
  console.log(opts.dryRun ? '=== DRY RUN — nothing written ===' : '=== Done ===');
  console.log(`  products ${opts.dryRun ? 'to fix' : 'fixed '}   ${productsFixed}`);
  console.log(`  ranges   ${opts.dryRun ? 'to fix' : 'fixed '}   ${groupsFixed}`);
  if (samples.length > 0) {
    console.log('');
    console.log('  Examples:');
    for (const s of samples) console.log(`    ${s}`);
  }
  console.log('');
  console.log('  The storefronts cache for 60s; the Google feeds rebuild overnight.');
}

// Only run when invoked directly, so the helpers above stay unit-testable.
if (process.argv[1]?.endsWith('repair-quoted-text.ts')) {
  main()
    .catch((err) => {
      console.error('[repair-quotes] FATAL:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void closeDatabase();
    });
}
