/**
 * Seed the hierarchical category taxonomy.
 *
 * Inserts the seven top-tier categories + their subcategories + the
 * hidden `Uncategorised` bucket. Idempotent — re-running upserts by
 * `(parent_id, slug)`, so a slug rename in `taxonomy.ts` reflects on
 * the next run without leaving orphans.
 *
 * Run after `db:migrate` and before `assign-categories.ts`.
 *
 * Usage:
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/seed-categories.ts
 *
 * The script:
 *   1. Inserts (or updates) the top-tier rows.
 *   2. Inserts (or updates) the subcategory rows with the right `parent_id`.
 *   3. Prints a tree summary at the end.
 *
 * Not destructive — won't remove rows that the seed doesn't list.
 * If you rename a slug in `taxonomy.ts`, the old row stays until
 * manually deleted (and any products pointing at it stay pointing
 * at it). That's a deliberate safety property: catalogue links
 * shouldn't 404 just because someone tweaked the taxonomy.
 */
import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { categories } from '../src/db/schema/index.js';
import { TAXONOMY, type TaxonomyTop } from '../src/modules/catalogue/taxonomy.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

interface SeedSummaryRow {
  top: string;
  sub: string | null;
  status: 'created' | 'updated';
}

async function upsertTop(top: TaxonomyTop, companyId: string): Promise<{ id: string; status: 'created' | 'updated' }> {
  const db = getDb();
  const existing = await db.query.categories.findFirst({
    where: and(
      eq(categories.companyId, companyId),
      eq(categories.slug, top.slug),
      isNull(categories.parentId),
      isNull(categories.deletedAt),
    ),
  });
  if (existing) {
    await db
      .update(categories)
      .set({
        name: top.name,
        description: top.description,
        sortOrder: top.sortOrder,
        isHidden: top.isHidden ?? false,
        updatedAt: new Date(),
      })
      .where(eq(categories.id, existing.id));
    return { id: existing.id, status: 'updated' };
  }
  const [inserted] = await db
    .insert(categories)
    .values({
      companyId,
      name: top.name,
      slug: top.slug,
      description: top.description,
      sortOrder: top.sortOrder,
      isHidden: top.isHidden ?? false,
    })
    .returning({ id: categories.id });
  if (!inserted) throw new Error(`Failed to insert top category ${top.slug}`);
  return { id: inserted.id, status: 'created' };
}

async function upsertSub(parentId: string, sub: { slug: string; name: string }, sortOrder: number, companyId: string): Promise<'created' | 'updated'> {
  const db = getDb();
  const existing = await db.query.categories.findFirst({
    where: and(
      eq(categories.companyId, companyId),
      eq(categories.slug, sub.slug),
      eq(categories.parentId, parentId),
      isNull(categories.deletedAt),
    ),
  });
  if (existing) {
    await db
      .update(categories)
      .set({
        name: sub.name,
        sortOrder,
        updatedAt: new Date(),
      })
      .where(eq(categories.id, existing.id));
    return 'updated';
  }
  await db.insert(categories).values({
    companyId,
    name: sub.name,
    slug: sub.slug,
    parentId,
    sortOrder,
    isHidden: false,
  });
  return 'created';
}

export async function seedCategories(): Promise<SeedSummaryRow[]> {
  const companyId = getSingletonCompanyId();
  const summary: SeedSummaryRow[] = [];
  for (const top of TAXONOMY) {
    const t = await upsertTop(top, companyId);
    summary.push({ top: top.slug, sub: null, status: t.status });
    for (let i = 0; i < top.children.length; i++) {
      const sub = top.children[i]!;
      const status = await upsertSub(t.id, sub, (i + 1) * 10, companyId);
      summary.push({ top: top.slug, sub: sub.slug, status });
    }
  }
  return summary;
}

const isCliEntry = process.argv[1]?.endsWith('seed-categories.ts') ?? false;

if (isCliEntry) {
  seedCategories()
    .then((summary) => {
      const created = summary.filter((r) => r.status === 'created').length;
      const updated = summary.filter((r) => r.status === 'updated').length;
      console.log('[seed-categories] OK');
      console.log(`  created: ${created}`);
      console.log(`  updated: ${updated}`);
      console.log('');
      for (const row of summary) {
        const path = row.sub ? `${row.top}/${row.sub}` : row.top;
        console.log(`  ${row.status === 'created' ? '+' : '·'} ${path}`);
      }
    })
    .catch((err) => {
      console.error('[seed-categories] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void closeDatabase();
    });
}
