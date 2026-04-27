/**
 * seed-storefront.ts — seed the Storefront Demo company with one published
 * group of three colour variants and one published standalone product.
 *
 * Run with:  npm run seed:storefront -w @smmta/api
 *
 * Idempotent: re-running wipes the Storefront Demo company's products and
 * groups (hard delete) and re-creates them. Other companies are untouched.
 *
 * The "Storefront Demo" company is identified by a fixed UUID. There is no
 * `companies` table — `company_id` is a free-form tenant key on every table.
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  productCategoryMappings,
  productGroups,
  productImages,
  products,
} from '../src/db/schema/index.js';

/** Stable identifier for the Storefront Demo company. */
export const STOREFRONT_DEMO_COMPANY_ID = '11111111-1111-4111-8111-111111111111';
export const STOREFRONT_DEMO_COMPANY_NAME = 'Storefront Demo';

/** picsum.photos seeded placeholder helpers — stable across runs. */
const img = (seed: string, w = 1200, h = 1200) =>
  `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;

interface SeedResult {
  companyId: string;
  groupId: string;
  variantIds: string[];
  standaloneId: string;
}

export async function seedStorefront(): Promise<SeedResult> {
  const db = getDb();
  const companyId = STOREFRONT_DEMO_COMPANY_ID;

  return db.transaction(async (tx) => {
    // -------- 1. Wipe ----------------------------------------------------
    // Hard delete in dependency order: images and category mappings first,
    // then products, then groups.
    const productIds = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.companyId, companyId));

    if (productIds.length > 0) {
      const ids = productIds.map((r) => r.id);
      await tx.delete(productImages).where(inArray(productImages.productId, ids));
      await tx
        .delete(productCategoryMappings)
        .where(inArray(productCategoryMappings.productId, ids));
      await tx.delete(products).where(inArray(products.id, ids));
    }
    await tx.delete(productGroups).where(eq(productGroups.companyId, companyId));

    // -------- 2. Group ---------------------------------------------------
    const [group] = await tx
      .insert(productGroups)
      .values({
        companyId,
        name: 'Aurora Filament Lamp',
        description: 'Designer LED filament lamp range — a statement piece in any room.',
        groupType: 'STOREFRONT',
        slug: 'aurora-filament-lamp',
        shortDescription:
          'Hand-finished LED filament lamps — soft, warm light, three signature colourways.',
        longDescription: [
          '## A modern take on the filament lamp',
          '',
          'The Aurora is a hand-finished, dimmable LED filament lamp inspired by the warm glow of',
          'classic Edison bulbs and updated for the way you live now.',
          '',
          '- 7W LED filament, 800 lumens, 2700K warm white',
          '- Dimmable on any standard trailing-edge dimmer',
          '- 25,000 hour rated lifespan, 2-year warranty',
          '- Designed in the UK, made in the EU',
        ].join('\n'),
        heroImageUrl: img('aurora-hero'),
        galleryImageUrls: [img('aurora-detail-1'), img('aurora-detail-2'), img('aurora-detail-3')],
        seoTitle: 'Aurora Filament Lamp | Designer LED Lighting',
        seoDescription:
          'Hand-finished LED filament lamps in three signature colourways. Dimmable, warm white, 25k hour rated. Free UK delivery.',
        seoKeywords: ['LED filament lamp', 'designer lighting', 'dimmable LED', 'warm white bulb'],
        isPublished: true,
        sortOrder: 0,
      })
      .returning();
    if (!group) throw new Error('Failed to insert product group');

    // -------- 3. Three colour variants -----------------------------------
    const variantsInput = [
      {
        name: 'Aurora Filament Lamp — Smoke',
        colour: 'Smoke',
        colourHex: '#3a3a3a',
        slug: 'aurora-filament-lamp-smoke',
        sortOrderInGroup: 0,
      },
      {
        name: 'Aurora Filament Lamp — Amber',
        colour: 'Amber',
        colourHex: '#d97706',
        slug: 'aurora-filament-lamp-amber',
        sortOrderInGroup: 1,
      },
      {
        name: 'Aurora Filament Lamp — Clear',
        colour: 'Clear',
        colourHex: '#f8fafc',
        slug: 'aurora-filament-lamp-clear',
        sortOrderInGroup: 2,
      },
    ];

    const variantRows = await tx
      .insert(products)
      .values(
        variantsInput.map((v) => ({
          companyId,
          name: v.name,
          stockCode: `AURORA-${v.colour.toUpperCase()}`,
          description: 'LED filament lamp — see group for full description.',
          expectedNextCost: '12.00',
          minSellingPrice: '24.00',
          maxSellingPrice: '34.00',
          productType: 'PHYSICAL' as const,
          // Storefront fields:
          groupId: group.id,
          colour: v.colour,
          colourHex: v.colourHex,
          slug: v.slug,
          shortDescription: `Aurora filament lamp in ${v.colour.toLowerCase()} glass.`,
          heroImageUrl: img(`aurora-${v.colour.toLowerCase()}-hero`),
          galleryImageUrls: [
            img(`aurora-${v.colour.toLowerCase()}-1`),
            img(`aurora-${v.colour.toLowerCase()}-2`),
          ],
          seoTitle: `Aurora Filament Lamp in ${v.colour}`,
          seoDescription: `${v.colour} colourway of the Aurora filament lamp. Dimmable, warm white LED.`,
          seoKeywords: ['LED filament lamp', `${v.colour.toLowerCase()} filament lamp`],
          isPublished: true,
          sortOrderInGroup: v.sortOrderInGroup,
        })),
      )
      .returning({ id: products.id });

    // -------- 4. Standalone product --------------------------------------
    const [standalone] = await tx
      .insert(products)
      .values({
        companyId,
        name: 'Brushed Brass Pendant Cord Set',
        stockCode: 'PENDANT-BRASS-3M',
        description: '3-metre fabric-covered pendant cord set with brushed brass fittings.',
        expectedNextCost: '8.00',
        minSellingPrice: '18.00',
        maxSellingPrice: '24.00',
        productType: 'PHYSICAL' as const,
        // Storefront fields (standalone — no group):
        groupId: null,
        slug: 'brushed-brass-pendant-cord-set',
        shortDescription:
          'Premium fabric-covered pendant cord with brushed brass fittings — 3 metres.',
        longDescription:
          'A heavy-weight braided fabric cord with brushed brass ceiling rose, bulb holder, and cord grip. Compatible with any E27 lamp. CE marked, supplied with full installation instructions.',
        heroImageUrl: img('pendant-brass-hero'),
        galleryImageUrls: [img('pendant-brass-1'), img('pendant-brass-2')],
        seoTitle: 'Brushed Brass Pendant Cord Set (3m)',
        seoDescription:
          'Heavy-weight fabric pendant cord with brushed brass fittings. 3 metres, E27 compatible, CE marked.',
        seoKeywords: ['pendant cord', 'brass ceiling rose', 'fabric flex', 'E27 pendant kit'],
        isPublished: true,
        sortOrderInGroup: 0,
      })
      .returning({ id: products.id });
    if (!standalone) throw new Error('Failed to insert standalone product');

    return {
      companyId,
      groupId: group.id,
      variantIds: variantRows.map((r) => r.id),
      standaloneId: standalone.id,
    };
  });
}

// Run only when invoked directly (e.g. `tsx scripts/seed-storefront.ts`),
// not when imported from a test file.
const isCliEntry = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  seedStorefront()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log(
        `[seed:storefront] OK — company=${result.companyId} group=${result.groupId} variants=${result.variantIds.length} standalone=${result.standaloneId}`,
      );
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[seed:storefront] FAILED:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void closeDatabase();
    });
}
