/**
 * Demo seed for both stores (§F).
 *
 * Idempotent for the parts that lend themselves (channel rows, supplier
 * row), creative for the parts that don't (sample products + supplier
 * mappings get inserted with deterministic stub stock counts so the
 * Clothes Shop has something to render against).
 *
 *   DATABASE_URL=... ENCRYPTION_KEY=... \
 *     npx tsx apps/api/scripts/seed-demo.ts
 *
 * Doesn't wipe — re-runs upsert-where-possible. If you want a hard
 * reset, drop the smmta_next + smmta_store DBs and re-run drizzle
 * migrations first.
 */
import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  channels,
  productGroups,
  products,
  supplierProducts,
  suppliers,
  warehouses,
} from '../src/db/schema/index.js';
import { DropshipSupplierService } from '../src/modules/suppliers/supplier-dropship.service.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

interface ClothesVariant {
  size: 'S' | 'M' | 'L' | 'XL';
  colour: string;
  colourHex: string;
  stock: number;
}

interface ClothesGroup {
  slug: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  basePrice: string;
  variants: ClothesVariant[];
}

const CLOTHES_GROUPS: ClothesGroup[] = [
  {
    slug: 'classic-cotton-tee',
    name: 'Classic Cotton T-Shirt',
    shortDescription: 'Soft heavyweight cotton, honest fit, 5 colours.',
    longDescription:
      '## Classic cotton tee\n\nThe everyday tee — 200gsm combed cotton, twin-needle stitched, ' +
      'and shrink-controlled so it holds its shape after the first wash.',
    basePrice: '14.00',
    variants: [
      { size: 'S', colour: 'Cream', colourHex: '#FFFCF6', stock: 15 },
      { size: 'M', colour: 'Cream', colourHex: '#FFFCF6', stock: 22 },
      { size: 'L', colour: 'Cream', colourHex: '#FFFCF6', stock: 18 },
      { size: 'XL', colour: 'Cream', colourHex: '#FFFCF6', stock: 8 },
      { size: 'S', colour: 'Pink', colourHex: '#E8537A', stock: 12 },
      { size: 'M', colour: 'Pink', colourHex: '#E8537A', stock: 0 },
      { size: 'L', colour: 'Pink', colourHex: '#E8537A', stock: 5 },
      { size: 'XL', colour: 'Pink', colourHex: '#E8537A', stock: 7 },
      { size: 'S', colour: 'Sage', colourHex: '#9CB59A', stock: 6 },
      { size: 'M', colour: 'Sage', colourHex: '#9CB59A', stock: 14 },
      { size: 'L', colour: 'Sage', colourHex: '#9CB59A', stock: 11 },
      { size: 'XL', colour: 'Sage', colourHex: '#9CB59A', stock: 4 },
    ],
  },
  {
    slug: 'soft-jersey-hoodie',
    name: 'Soft Jersey Hoodie',
    shortDescription: 'Brushed-back jersey, drawstring hood, kangaroo pocket.',
    longDescription:
      '## Soft jersey hoodie\n\nMid-weight jersey with a brushed inside for the cosy lean of a ' +
      'sweatshirt without the bulk. Tone-on-tone drawstring, kangaroo pocket, and a flat-lock ' +
      'hem that lays right.',
    basePrice: '38.00',
    variants: [
      { size: 'S', colour: 'Charcoal', colourHex: '#3A3454', stock: 9 },
      { size: 'M', colour: 'Charcoal', colourHex: '#3A3454', stock: 14 },
      { size: 'L', colour: 'Charcoal', colourHex: '#3A3454', stock: 7 },
      { size: 'XL', colour: 'Charcoal', colourHex: '#3A3454', stock: 3 },
      { size: 'S', colour: 'Peach', colourHex: '#FFD7C0', stock: 6 },
      { size: 'M', colour: 'Peach', colourHex: '#FFD7C0', stock: 0 },
      { size: 'L', colour: 'Peach', colourHex: '#FFD7C0', stock: 4 },
      { size: 'XL', colour: 'Peach', colourHex: '#FFD7C0', stock: 0 },
    ],
  },
];

async function ensureChannel(slug: string, name: string) {
  const db = getDb();
  const existing = await db.query.channels.findFirst({
    where: and(eq(channels.slug, slug), isNull(channels.deletedAt)),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(channels)
    .values({ slug, kind: 'STOREFRONT', displayName: name, isActive: true })
    .returning();
  console.log(`[demo] created channel ${slug}`);
  return created!;
}

async function ensureSupplier(companyId: string) {
  const db = getDb();
  const existing = await db.query.suppliers.findFirst({
    where: eq(suppliers.slug, 'demo-uneek'),
  });
  if (existing) return existing;
  const service = new DropshipSupplierService();
  const [s] = await db
    .insert(suppliers)
    .values({
      companyId,
      name: 'Demo Uneek (sandbox)',
      slug: 'demo-uneek',
      connectorKind: 'UNEEK',
      apiBaseUrl: 'https://api.uneekclothing.com/',
      apiKeyEnc: service.encryptApiKey(process.env.UNEEK_DEMO_KEY ?? 'demo-key-replace-me'),
      apiAuthScheme: 'bearer',
      isDropshipActive: true,
      pollIntervalMinutes: 180,
    })
    .returning();
  console.log('[demo] created supplier demo-uneek');
  return s!;
}

async function seedClothes(companyId: string) {
  const db = getDb();
  const supplier = await ensureSupplier(companyId);

  for (const group of CLOTHES_GROUPS) {
    let g = await db.query.productGroups.findFirst({
      where: and(eq(productGroups.slug, group.slug), isNull(productGroups.deletedAt)),
    });
    if (!g) {
      const [created] = await db
        .insert(productGroups)
        .values({
          companyId,
          name: group.name,
          slug: group.slug,
          shortDescription: group.shortDescription,
          longDescription: group.longDescription,
          isPublished: true,
          attributeAxes: ['size', 'colour'],
          groupType: 'STOREFRONT',
        })
        .returning();
      g = created!;
      console.log(`[demo] created group ${group.slug}`);
    }
    for (const v of group.variants) {
      const slug = `${group.slug}-${v.size.toLowerCase()}-${v.colour.toLowerCase()}`;
      let p = await db.query.products.findFirst({
        where: and(eq(products.slug, slug), isNull(products.deletedAt)),
      });
      if (!p) {
        const [created] = await db
          .insert(products)
          .values({
            companyId,
            groupId: g.id,
            slug,
            name: `${group.name} — ${v.colour} (${v.size})`,
            colour: v.colour,
            colourHex: v.colourHex,
            attributes: { size: v.size, colour: v.colour },
            minSellingPrice: group.basePrice,
            maxSellingPrice: group.basePrice,
            isPublished: true,
          })
          .returning();
        p = created!;
      }
      // Upsert the supplier mapping with the demo stock count.
      const supplierSku = `${group.slug.toUpperCase()}-${v.size}-${v.colour.toUpperCase().slice(0, 3)}`;
      const existing = await db.query.supplierProducts.findFirst({
        where: and(
          eq(supplierProducts.productId, p.id),
          eq(supplierProducts.supplierId, supplier.id),
        ),
      });
      if (existing) {
        await db
          .update(supplierProducts)
          .set({
            supplierSku,
            costGbp: '5.00',
            lastKnownStock: v.stock,
            lastKnownPrice: '5.00',
            lastPolledAt: new Date(),
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(supplierProducts.id, existing.id));
      } else {
        await db.insert(supplierProducts).values({
          companyId,
          productId: p.id,
          supplierId: supplier.id,
          supplierSku,
          costGbp: '5.00',
          lastKnownStock: v.stock,
          lastKnownPrice: '5.00',
          lastPolledAt: new Date(),
          isActive: true,
        });
      }
    }
  }
}

async function main() {
  const companyId = getSingletonCompanyId();
  console.log('[demo] singleton company:', companyId);

  // Ensure both storefront channels + a default warehouse exist.
  await ensureChannel('filament-store', 'Filament Store');
  await ensureChannel('clothes-shop', 'Clothes Shop');
  const db = getDb();
  const wh = await db.query.warehouses.findFirst({
    where: and(eq(warehouses.companyId, companyId), eq(warehouses.isDefault, true)),
  });
  if (!wh) {
    await db
      .insert(warehouses)
      .values({ companyId, name: 'Demo Warehouse', isDefault: true })
      .returning();
    console.log('[demo] created default warehouse');
  }

  await seedClothes(companyId);
  console.log('[demo] OK');
}

main()
  .catch((err) => {
    console.error('[seed-demo] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
