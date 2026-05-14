/**
 * Backfill / re-assignment of `products.category_id` from the rule
 * set in `category-mapping.ts`.
 *
 * Streams every published product (deleted_at IS NULL), reads its
 * supplier source + the group-level metadata captured at import,
 * evaluates the rules, and writes `category_id`. Products that
 * don't match any rule land in the hidden `uncategorised` bucket.
 *
 * Usage:
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/assign-categories.ts [--dry-run] [--limit N]
 *
 * Flags:
 *   --dry-run   Walk + classify but write nothing. Prints the same
 *               summary as a real run so you can preview the impact
 *               of a rule change.
 *   --limit N   Process only the first N products. For quick smoke
 *               tests.
 *
 * Idempotent. Updates `category_id` even if already set, so a rule
 * change propagates on the next run.
 *
 * Run order:
 *   1. `npm run db:migrate` (categories table + products.category_id)
 *   2. `npx tsx apps/api/scripts/seed-categories.ts`     (taxonomy rows exist)
 *   3. `npx tsx apps/api/scripts/assign-categories.ts`   (this script)
 */
import 'dotenv/config';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  categories,
  productGroups,
  products,
  suppliers,
  supplierProducts,
} from '../src/db/schema/index.js';
import {
  evaluateRules,
  type ProductFacts,
} from '../src/modules/catalogue/category-mapping.js';
import { findTaxonomyEntry } from '../src/modules/catalogue/taxonomy.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

interface CliOpts {
  dryRun: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): CliOpts {
  let dryRun = false;
  let limit: number | null = null;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length));
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`bad --limit value: ${a}`);
        process.exit(2);
      }
      limit = Math.floor(n);
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: npx tsx apps/api/scripts/assign-categories.ts [--dry-run] [--limit N]');
      process.exit(0);
    }
  }
  return { dryRun, limit };
}

interface AssignSummary {
  scanned: number;
  assigned: number;
  uncategorised: number;
  unchanged: number;
  perCategory: Map<string, number>;
  /** Top 20 product-name samples that fell into uncategorised, so the
   *  operator can spot patterns the rules are missing. */
  uncategorisedSamples: string[];
}

/** Resolve every category slug-path to its UUID. One round-trip so
 *  the row update loop doesn't keep re-querying. */
async function loadCategoryIndex(companyId: string): Promise<{
  bySlugPath: Map<string, string>;
  uncategorisedId: string;
}> {
  const db = getDb();
  const rows = await db.query.categories.findMany({
    where: and(eq(categories.companyId, companyId), isNull(categories.deletedAt)),
  });
  // Build a map from `parent_id → row`, then derive slug paths.
  const byId = new Map<string, typeof rows[number]>();
  const tops: typeof rows = [];
  for (const r of rows) {
    byId.set(r.id, r);
    if (r.parentId === null) tops.push(r);
  }
  const bySlugPath = new Map<string, string>();
  for (const top of tops) {
    if (top.slug) bySlugPath.set(top.slug, top.id);
  }
  for (const r of rows) {
    if (r.parentId === null) continue;
    const parent = byId.get(r.parentId);
    if (!parent || !parent.slug || !r.slug) continue;
    bySlugPath.set(`${parent.slug}/${r.slug}`, r.id);
  }
  const uncategorisedId = bySlugPath.get('uncategorised');
  if (!uncategorisedId) {
    throw new Error(
      "No 'uncategorised' category found. Run seed-categories.ts first.",
    );
  }
  return { bySlugPath, uncategorisedId };
}

const BATCH_SIZE = 500;

export async function runAssignCategories(opts: CliOpts): Promise<AssignSummary> {
  const companyId = getSingletonCompanyId();
  const db = getDb();

  const { bySlugPath, uncategorisedId } = await loadCategoryIndex(companyId);

  const summary: AssignSummary = {
    scanned: 0,
    assigned: 0,
    uncategorised: 0,
    unchanged: 0,
    perCategory: new Map(),
    uncategorisedSamples: [],
  };

  // Build a lookup productId → supplier slug. One query for all of
  // them — supplier_products rowcount is bounded by product count.
  const supplierLinks = await db
    .select({
      productId: supplierProducts.productId,
      slug: suppliers.slug,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(isNull(supplierProducts.deletedAt));
  const supplierBySku = new Map<string, string>();
  for (const r of supplierLinks) {
    if (r.slug) supplierBySku.set(r.productId, r.slug);
  }

  // Walk products in pages — avoids loading the whole table into
  // memory on a 100k-row catalogue.
  let offset = 0;
  const targetLimit = opts.limit ?? Infinity;
  const updateQueue: Array<{ id: string; categoryId: string }> = [];

  for (;;) {
    const page = await db
      .select({
        id: products.id,
        name: products.name,
        currentCategoryId: products.categoryId,
        groupId: products.groupId,
        groupType: productGroups.groupType,
        groupName: productGroups.name,
      })
      .from(products)
      .leftJoin(productGroups, eq(productGroups.id, products.groupId))
      .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)))
      .orderBy(products.id)
      .limit(BATCH_SIZE)
      .offset(offset);

    if (page.length === 0) break;

    for (const row of page) {
      if (summary.scanned >= targetLimit) break;
      summary.scanned++;
      const facts: ProductFacts = {
        source: supplierBySku.get(row.id) ?? 'unknown',
        productType: row.groupType,
        categorisation: row.groupType,
        // No gender/ageGroup captured at import time — rules fall
        // back to name-based detection.
        name: [row.groupName, row.name].filter(Boolean).join(' '),
      };
      const slugPath = evaluateRules(facts);
      let targetCategoryId: string;
      if (slugPath) {
        const id = bySlugPath.get(slugPath);
        if (!id) {
          // Rule's assignTo doesn't exist in DB despite being in
          // taxonomy — seed-categories.ts hasn't been run. Fail
          // loudly rather than silently dumping into uncategorised.
          throw new Error(
            `Rule assigned to "${slugPath}" but no category row found. ` +
              'Run seed-categories.ts.',
          );
        }
        targetCategoryId = id;
        summary.assigned++;
        summary.perCategory.set(slugPath, (summary.perCategory.get(slugPath) ?? 0) + 1);
      } else {
        targetCategoryId = uncategorisedId;
        summary.uncategorised++;
        summary.perCategory.set('uncategorised', (summary.perCategory.get('uncategorised') ?? 0) + 1);
        if (summary.uncategorisedSamples.length < 20) {
          summary.uncategorisedSamples.push(row.name);
        }
      }
      if (row.currentCategoryId === targetCategoryId) {
        summary.unchanged++;
      } else {
        updateQueue.push({ id: row.id, categoryId: targetCategoryId });
      }
    }

    if (summary.scanned >= targetLimit) break;
    offset += page.length;
    if (page.length < BATCH_SIZE) break;
  }

  // Flush updates in chunks. Each chunk = one transaction.
  // (CASE WHEN .. THEN .. END is faster than per-row UPDATE for
  // thousands of rows.)
  if (!opts.dryRun && updateQueue.length > 0) {
    const UPDATE_CHUNK = 1000;
    for (let i = 0; i < updateQueue.length; i += UPDATE_CHUNK) {
      const chunk = updateQueue.slice(i, i + UPDATE_CHUNK);
      // Group chunk by target categoryId so we issue one UPDATE per
      // distinct category. This keeps the SQL simple and lets
      // Postgres use the index on category_id.
      const byCategory = new Map<string, string[]>();
      for (const u of chunk) {
        const arr = byCategory.get(u.categoryId);
        if (arr) arr.push(u.id);
        else byCategory.set(u.categoryId, [u.id]);
      }
      await db.transaction(async (tx) => {
        for (const [catId, productIds] of byCategory) {
          // `inArray` with thousands of ids is fine here (chunk is ≤1000).
          await tx
            .update(products)
            .set({ categoryId: catId, updatedAt: new Date() })
            .where(
              and(
                eq(products.companyId, companyId),
                sql`${products.id} = ANY(ARRAY[${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[])` satisfies SQL,
              ),
            );
        }
      });
    }
  }

  return summary;
}

function printSummary(s: AssignSummary, dryRun: boolean): void {
  console.log(`[assign-categories] ${dryRun ? 'DRY RUN — ' : ''}summary:`);
  console.log(`  scanned:        ${s.scanned}`);
  console.log(`  assigned:       ${s.assigned}`);
  console.log(`  uncategorised:  ${s.uncategorised}  (${pct(s.uncategorised, s.scanned)})`);
  console.log(`  unchanged:      ${s.unchanged}`);
  console.log('');
  console.log('Per-category counts:');
  const entries = [...s.perCategory.entries()].sort((a, b) => b[1] - a[1]);
  for (const [path, count] of entries) {
    console.log(`  ${count.toString().padStart(7)}  ${path}`);
  }
  if (s.uncategorisedSamples.length > 0) {
    console.log('');
    console.log('Sample uncategorised product names (consider adding rules):');
    for (const n of s.uncategorisedSamples) {
      console.log(`  - ${n}`);
    }
  }
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '0.0%';
  return `${((part * 100) / whole).toFixed(1)}%`;
}

const isCliEntry = process.argv[1]?.endsWith('assign-categories.ts') ?? false;
if (isCliEntry) {
  const opts = parseArgs(process.argv.slice(2));
  runAssignCategories(opts)
    .then((summary) => {
      printSummary(summary, opts.dryRun);
      // Sanity: validate that every rule's assignTo exists in the DB
      // catalog (fail-fast paranoia in case seed-categories drift).
      for (const slugPath of summary.perCategory.keys()) {
        if (slugPath === 'uncategorised') continue;
        if (!findTaxonomyEntry(slugPath)) {
          console.error(`WARNING: assigned to "${slugPath}" which isn't in taxonomy.ts`);
        }
      }
    })
    .catch((err) => {
      console.error('[assign-categories] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void closeDatabase();
    });
}
