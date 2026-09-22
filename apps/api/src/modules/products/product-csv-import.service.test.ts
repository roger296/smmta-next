/**
 * Importing a product file end to end against a real database: products
 * are created with their manufacturer, group, images and marketplace SKUs;
 * a second import updates in place and never doubles a group or an image;
 * a blank cell leaves a value alone; and an EAN owned by another product
 * refuses the row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { manufacturers, productGroups, productImages, products } from '../../db/schema/index.js';
import { ProductCsvImportService } from './product-csv-import.service.js';

const COMPANY_ID = '99999999-9999-4999-8999-999999999999';
const MAKER = 'Import Test Makers';

const HEADER = 'Stock Code,Product Name,Fully Qualified Name,ProductGroupId,Manufacturer,Product Description,Net Weight,EAN Code,Main Selling Price,Expected Next Cost,Color,Product Type,Seller Integration SKU,Integration SKU 2,Image 1,Image 2';
const rows = [
  'IMP-S,Band Ring,Band Ring Small,7001,' + MAKER + ',"A ring, small",0.05,5012345678900,24.95,4.99,Small,Physical,IMP-S,AMZ-IMP-S,https://img.example.com/s1.jpg,https://img.example.com/s2.jpg',
  'IMP-M,Band Ring,Band Ring Medium,7001,' + MAKER + ',"A ring, medium",0.06,,24.95,4.99,Medium,Physical,IMP-M,,https://img.example.com/m1.jpg,',
  'IMP-SVC,Engraving,,,,Engraving service,,,5.00,0,,Service,,,,',
];

const service = new ProductCsvImportService();

async function cleanup() {
  const db = getDb();
  const owned = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY_ID));
  if (owned.length > 0) await db.delete(productImages).where(inArray(productImages.productId, owned.map((p) => p.id)));
  await db.delete(products).where(eq(products.companyId, COMPANY_ID));
  await db.delete(productGroups).where(eq(productGroups.companyId, COMPANY_ID));
  await db.delete(manufacturers).where(like(manufacturers.name, 'Import Test%'));
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await closeDatabase();
});

async function byCode(stockCode: string) {
  return getDb().query.products.findFirst({
    where: eq(products.stockCode, stockCode),
    with: { manufacturer: true, group: true },
  });
}

describe('ProductCsvImportService', () => {
  it('creates the products, their manufacturer, one group for the range and their images', async () => {
    const result = await service.importCsv(COMPANY_ID, [HEADER, ...rows].join('\r\n'));
    expect(result.problems).toEqual([]);
    expect(result).toMatchObject({ rows: 3, created: 3, updated: 0, skipped: 0, failed: 0, groupsCreated: 1, manufacturersCreated: 1 });

    const small = await byCode('IMP-S');
    expect(small).toMatchObject({
      name: 'Band Ring Small',
      brand: MAKER,
      description: 'A ring, small',
      weight: '0.050',
      ean: '5012345678900',
      minSellingPrice: '24.95',
      maxSellingPrice: '24.95',
      expectedNextCost: '4.99',
      colour: 'Small',
      productType: 'PHYSICAL',
      marketplaceIdentifiers: { sellerSkus: ['IMP-S', 'AMZ-IMP-S'] },
      heroImageUrl: 'https://img.example.com/s1.jpg',
      galleryImageUrls: ['https://img.example.com/s1.jpg', 'https://img.example.com/s2.jpg'],
      attributes: { colour: 'Small' },
    });
    expect(small!.manufacturer?.name).toBe(MAKER);
    expect(small!.group?.name).toBe('Band Ring');
    expect(small!.group?.oldId).toBe(7001);

    const medium = await byCode('IMP-M');
    expect(medium!.groupId).toBe(small!.groupId);
    expect(medium!.ean).toBeNull();

    const svc = await byCode('IMP-SVC');
    expect(svc).toMatchObject({ name: 'Engraving', productType: 'SERVICE', groupId: null, manufacturerId: null, expectedNextCost: '0.00' });

    const images = await getDb().select().from(productImages).where(eq(productImages.productId, small!.id));
    expect(images.map((i) => [i.priority, i.imageUrl])).toEqual([[0, 'https://img.example.com/s1.jpg'], [1, 'https://img.example.com/s2.jpg']]);
  });

  it('updates in place on a second import without doubling groups or images, and a blank cell leaves a value alone', async () => {
    const changed = rows[0]!.replace('24.95,4.99,Small', '29.95,,Small').replace('"A ring, small"', '');
    const result = await service.importCsv(COMPANY_ID, [HEADER, changed, rows[1]!].join('\n'));
    expect(result).toMatchObject({ created: 0, updated: 2, groupsCreated: 0, manufacturersCreated: 0, failed: 0 });

    const small = await byCode('IMP-S');
    expect(small!.minSellingPrice).toBe('29.95');
    expect(small!.expectedNextCost).toBe('4.99');
    expect(small!.description).toBe('A ring, small');
    const groups = await getDb().select().from(productGroups).where(eq(productGroups.companyId, COMPANY_ID));
    expect(groups).toHaveLength(1);
    const images = await getDb().select().from(productImages).where(eq(productImages.productId, small!.id));
    expect(images).toHaveLength(2);
  });

  it('skips existing stock codes when asked not to update', async () => {
    const result = await service.importCsv(COMPANY_ID, [HEADER, rows[0]!].join('\n'), { updateExisting: false });
    expect(result).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(result.problems[0]).toMatchObject({ line: 2, stockCode: 'IMP-S', kind: 'skipped' });
  });

  it("refuses a row claiming another product's EAN and reports the line", async () => {
    const clash = rows[1]!.replace('0.06,,24.95', '0.06,5012345678900,24.95');
    const result = await service.importCsv(COMPANY_ID, [HEADER, clash].join('\n'));
    expect(result).toMatchObject({ created: 0, updated: 0, failed: 1 });
    expect(result.problems).toEqual([{ line: 2, stockCode: 'IMP-M', kind: 'failed', message: 'EAN 5012345678900 already belongs to IMP-S' }]);
  });
});
