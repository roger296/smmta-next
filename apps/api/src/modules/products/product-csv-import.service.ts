/**
 * Writes the rows `parseProductsCsv` read into the catalogue.
 *
 * One product per stock code. A stock code already in the catalogue is
 * updated when the caller asks for that, and otherwise left alone: the file
 * never clears a value the product already has, it only fills or replaces
 * with what the file says. Rows sharing a group id (or, without one, a
 * range name) become a product group when there are at least two of them,
 * so size and colour variants sit together as they do everywhere else in
 * the system. Manufacturers named in the file are created when unknown.
 * Images are written only for a product that has none, so a curated set
 * in the admin is never overwritten by a re-import.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { manufacturers, productGroups, productImages, products } from '../../db/schema/index.js';
import { parseProductsCsv, type ParsedProductRow } from './product-csv-import.js';

export interface ProductImportOptions {
  /** Update products whose stock code already exists. Default true. */
  updateExisting?: boolean;
}

export interface ProductImportProblem {
  line: number;
  stockCode: string | null;
  kind: 'skipped' | 'failed';
  message: string;
}

export interface ProductImportResult {
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  groupsCreated: number;
  manufacturersCreated: number;
  problems: ProductImportProblem[];
}

export class ProductCsvImportService {
  private readonly db = getDb();

  async importCsv(companyId: string, csvText: string, options: ProductImportOptions = {}): Promise<ProductImportResult> {
    const updateExisting = options.updateExisting ?? true;
    const parsed = parseProductsCsv(csvText);
    const result: ProductImportResult = {
      rows: parsed.rows.length + parsed.skipped.length,
      created: 0,
      updated: 0,
      skipped: parsed.skipped.length,
      failed: 0,
      groupsCreated: 0,
      manufacturersCreated: 0,
      problems: parsed.skipped.map((s) => ({ line: s.line, stockCode: s.stockCode, kind: 'skipped' as const, message: s.reason })),
    };

    const manufacturerIds = new Map<string, string>();
    const groupIds = await this.resolveGroups(companyId, parsed.rows, result);

    for (const row of parsed.rows) {
      try {
        const manufacturerId = row.manufacturer
          ? await this.resolveManufacturer(row.manufacturer, manufacturerIds, result)
          : null;
        const groupId = groupIds.get(row.groupKey) ?? null;
        const existing = await this.db.query.products.findFirst({
          where: and(eq(products.companyId, companyId), eq(products.stockCode, row.stockCode), isNull(products.deletedAt)),
          columns: { id: true, heroImageUrl: true },
        });

        if (existing && !updateExisting) {
          result.skipped++;
          result.problems.push({ line: row.line, stockCode: row.stockCode, kind: 'skipped', message: 'Stock code already exists' });
          continue;
        }

        await this.checkEan(companyId, row, existing?.id ?? null);

        if (existing) {
          await this.updateProduct(existing.id, row, manufacturerId, groupId, existing.heroImageUrl === null);
          result.updated++;
        } else {
          await this.createProduct(companyId, row, manufacturerId, groupId);
          result.created++;
        }
      } catch (err) {
        result.failed++;
        result.problems.push({ line: row.line, stockCode: row.stockCode, kind: 'failed', message: (err as Error).message });
      }
    }

    return result;
  }

  // ── Groups: one per key with two or more rows ──

  private async resolveGroups(companyId: string, rows: ParsedProductRow[], result: ProductImportResult): Promise<Map<string, string>> {
    const byKey = new Map<string, ParsedProductRow[]>();
    for (const row of rows) {
      const list = byKey.get(row.groupKey);
      if (list) list.push(row);
      else byKey.set(row.groupKey, [row]);
    }

    const ids = new Map<string, string>();
    for (const [key, members] of byKey) {
      if (members.length < 2) continue;
      const first = members[0]!;
      let group = first.oldGroupId !== null
        ? await this.db.query.productGroups.findFirst({
            where: and(eq(productGroups.companyId, companyId), eq(productGroups.oldId, first.oldGroupId), isNull(productGroups.deletedAt)),
            columns: { id: true },
          })
        : undefined;
      if (!group) {
        group = await this.db.query.productGroups.findFirst({
          where: and(
            eq(productGroups.companyId, companyId),
            sql`lower(${productGroups.name}) = lower(${first.rangeName})`,
            isNull(productGroups.deletedAt),
          ),
          columns: { id: true },
        });
      }
      if (!group) {
        const [created] = await this.db
          .insert(productGroups)
          .values({
            companyId,
            name: first.rangeName,
            description: first.description,
            oldId: first.oldGroupId,
            attributeAxes: members.some((m) => m.colour) ? ['colour'] : null,
            categoryHints: first.tags.length > 0 ? { productType: first.tags[0], categorisation: first.tags.slice(1).join(' | ') || null } : null,
          })
          .returning({ id: productGroups.id });
        group = created!;
        result.groupsCreated++;
      }
      ids.set(key, group.id);
    }
    return ids;
  }

  // ── Manufacturers: by name, created when unknown ──

  private async resolveManufacturer(name: string, cache: Map<string, string>, result: ProductImportResult): Promise<string> {
    const key = name.toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;
    let row = await this.db.query.manufacturers.findFirst({
      where: and(sql`lower(${manufacturers.name}) = ${key}`, isNull(manufacturers.deletedAt)),
      columns: { id: true },
    });
    if (!row) {
      const [created] = await this.db.insert(manufacturers).values({ name }).returning({ id: manufacturers.id });
      row = created!;
      result.manufacturersCreated++;
    }
    cache.set(key, row.id);
    return row.id;
  }

  /** An EAN belongs to one product; a file row claiming another product's EAN is refused. */
  private async checkEan(companyId: string, row: ParsedProductRow, ownId: string | null): Promise<void> {
    if (!row.ean) return;
    const other = await this.db.query.products.findFirst({
      where: and(eq(products.companyId, companyId), eq(products.ean, row.ean), isNull(products.deletedAt)),
      columns: { id: true, stockCode: true },
    });
    if (other && other.id !== ownId) {
      throw new Error(`EAN ${row.ean} already belongs to ${other.stockCode ?? 'another product'}`);
    }
  }

  private fields(row: ParsedProductRow, manufacturerId: string | null, groupId: string | null) {
    const price = row.sellingPrice;
    return {
      name: row.name,
      manufacturerId,
      brand: row.manufacturer,
      manufacturerPartNumber: row.manufacturerPartNumber,
      description: row.description,
      expectedNextCost: row.expectedNextCost !== null ? row.expectedNextCost.toFixed(2) : undefined,
      minSellingPrice: price !== null ? price.toFixed(2) : undefined,
      maxSellingPrice: price !== null ? price.toFixed(2) : undefined,
      ean: row.ean,
      productType: row.productType,
      requireSerialNumber: row.requireSerialNumber,
      requireBatchNumber: row.requireBatchNumber,
      weight: row.weightKg !== null ? row.weightKg.toFixed(3) : undefined,
      height: row.heightCm !== null ? row.heightCm.toFixed(2) : undefined,
      width: row.widthCm !== null ? row.widthCm.toFixed(2) : undefined,
      length: row.lengthCm !== null ? row.lengthCm.toFixed(2) : undefined,
      hsCode: row.hsCode,
      marketplaceIdentifiers: row.sellerSkus.length > 0 ? { sellerSkus: row.sellerSkus } : undefined,
      groupId,
      colour: row.colour,
      attributes: groupId && row.colour ? { colour: row.colour } : undefined,
    };
  }

  private async createProduct(companyId: string, row: ParsedProductRow, manufacturerId: string | null, groupId: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [product] = await tx
        .insert(products)
        .values({ companyId, stockCode: row.stockCode, ...this.fields(row, manufacturerId, groupId), expectedNextCost: row.expectedNextCost?.toFixed(2) ?? '0' })
        .returning({ id: products.id });
      await this.writeImages(tx, product!.id, row.imageUrls);
    });
  }

  private async updateProduct(id: string, row: ParsedProductRow, manufacturerId: string | null, groupId: string | null, writeImages: boolean): Promise<void> {
    const fields = this.fields(row, manufacturerId, groupId);
    // A blank cell leaves the product's value alone.
    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
    await this.db.transaction(async (tx) => {
      await tx.update(products).set({ ...set, updatedAt: new Date() }).where(eq(products.id, id));
      if (writeImages) await this.writeImages(tx, id, row.imageUrls);
    });
  }

  private async writeImages(tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0], productId: string, urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    await tx.insert(productImages).values(urls.map((imageUrl, priority) => ({ productId, imageUrl, priority })));
    await tx.update(products).set({ heroImageUrl: urls[0]!, galleryImageUrls: urls }).where(eq(products.id, productId));
  }
}
