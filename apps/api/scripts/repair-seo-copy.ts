/**
 * Repairs generated SEO copy on EXISTING catalogue rows.
 *
 * Two audit findings live in text that was generated once at seed time
 * and written to the database:
 *
 *   Bug 06  "… from 1 colours." — ungrammatical, and it shows in the
 *           meta description Google displays.
 *   Bug 07  Variant descriptions promised "free UK delivery" while
 *           checkout charges £4.95. Harmless while variant pages were
 *           noindexed; a consumer-protection problem the moment they
 *           index (which this same release does).
 *
 * Fixing the generator in seed-storefront.ts only affects future seeds,
 * and that script DELETES and recreates products — running it against
 * production would destroy stock items, images, category mappings and
 * the Ralawise import. So this script rewrites the two text columns in
 * place and touches nothing else.
 *
 * Idempotent: re-running changes nothing once the copy is correct.
 *
 *   npm run repair:seo-copy --workspace=@smmta/api          # dry run
 *   npm run repair:seo-copy --workspace=@smmta/api -- --write
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, closeDatabase } from '../src/config/database.js';
import { getEnv } from '../src/config/env.js';
import { products, productGroups } from '../src/db/schema/index.js';

/** Must match DELIVERY_CLAIM in seed-storefront.ts. */
export const DELIVERY_CLAIM = 'fast UK delivery';
const WRONG_CLAIMS = ['free UK delivery', 'Free UK delivery'];

export function fixDeliveryClaim(text: string): string {
  let out = text;
  for (const wrong of WRONG_CLAIMS) out = out.split(wrong).join(DELIVERY_CLAIM);
  return out;
}

/**
 * "from 1 colours" → "in <Colour>" when we know it, else "in one colour".
 * Leaves every other count alone.
 */
export function fixColourCount(text: string, soleColour: string | null): string {
  return text.replace(
    /\bfrom 1 colours\b/gi,
    soleColour ? `in ${soleColour}` : 'in one colour',
  );
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const db = getDb();
  const companyId = getEnv().COMPANY_ID;

  let groupsFixed = 0;
  let productsFixed = 0;

  // ---- Groups ----
  const groups = await db
    .select({
      id: productGroups.id,
      name: productGroups.name,
      seoDescription: productGroups.seoDescription,
      shortDescription: productGroups.shortDescription,
    })
    .from(productGroups)
    .where(eq(productGroups.companyId, companyId));

  for (const g of groups) {
    // A single-colour group: find its one variant's colour so the copy
    // can name it rather than counting to one.
    const variants = await db
      .select({ colour: products.colour })
      .from(products)
      .where(
        and(
          eq(products.companyId, companyId),
          eq(products.groupId, g.id),
          isNull(products.deletedAt),
        ),
      );
    const soleColour = variants.length === 1 ? (variants[0]!.colour ?? null) : null;

    const nextSeo = g.seoDescription
      ? fixColourCount(fixDeliveryClaim(g.seoDescription), soleColour)
      : g.seoDescription;
    const nextShort = g.shortDescription
      ? fixColourCount(fixDeliveryClaim(g.shortDescription), soleColour)
      : g.shortDescription;

    if (nextSeo !== g.seoDescription || nextShort !== g.shortDescription) {
      groupsFixed++;
      console.log(`  group  ${g.name}`);
      if (nextSeo !== g.seoDescription) console.log(`    seo:   ${g.seoDescription} → ${nextSeo}`);
      if (nextShort !== g.shortDescription) console.log(`    short: ${g.shortDescription} → ${nextShort}`);
      if (write) {
        await db
          .update(productGroups)
          .set({ seoDescription: nextSeo, shortDescription: nextShort })
          .where(eq(productGroups.id, g.id));
      }
    }
  }

  // ---- Products ----
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      colour: products.colour,
      seoDescription: products.seoDescription,
      shortDescription: products.shortDescription,
    })
    .from(products)
    .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));

  for (const p of rows) {
    const nextSeo = p.seoDescription
      ? fixColourCount(fixDeliveryClaim(p.seoDescription), p.colour ?? null)
      : p.seoDescription;
    const nextShort = p.shortDescription
      ? fixColourCount(fixDeliveryClaim(p.shortDescription), p.colour ?? null)
      : p.shortDescription;

    if (nextSeo !== p.seoDescription || nextShort !== p.shortDescription) {
      productsFixed++;
      if (productsFixed <= 10) console.log(`  product ${p.name}: ${p.seoDescription} → ${nextSeo}`);
      if (write) {
        await db
          .update(products)
          .set({ seoDescription: nextSeo, shortDescription: nextShort })
          .where(eq(products.id, p.id));
      }
    }
  }

  console.log(
    `\n${write ? 'Updated' : 'Would update'}: ${groupsFixed} groups, ${productsFixed} products.`,
  );
  if (!write && groupsFixed + productsFixed > 0) {
    console.log('Re-run with --write to apply.');
  }
  void sql;
  await closeDatabase();
}

/**
 * Only self-execute when run as a script. The pure helpers above are
 * imported by repair-seo-copy.test.ts, which must not open a database
 * connection just to check a regex.
 */
if (process.argv[1] && process.argv[1].includes('repair-seo-copy')) {
  main().catch(async (err) => {
    console.error(err);
    await closeDatabase();
    process.exit(1);
  });
}
