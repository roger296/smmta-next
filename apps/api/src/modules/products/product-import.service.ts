/**
 * Applies a parsed product CSV: create what is missing, update what exists,
 * keyed on stock code. See `product-import.ts` for the format rules.
 *
 * Runs inside ONE transaction. A half-applied catalogue import is the worst
 * outcome available — the operator cannot tell which rows landed, and re-running
 * to "finish" would re-apply the ones that did. Either the whole file goes in
 * or none of it does, and `dryRun` gives the same report with nothing written.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { itemCategories, products } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  parseProductCsv,
  type ImportRowError,
  type ParsedImportRow,
} from './product-import.js';

export interface ProductImportOptions {
  dryRun?: boolean;
  /** Mint an item category the file names but the system does not have. */
  createMissingCategories?: boolean;
}

export interface ProductImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  /** Rows that could not be applied. Nothing is written when this is non-empty. */
  errors: ImportRowError[];
  ignoredColumns: string[];
  unknownColumns: string[];
  /** Item categories this run created (empty unless createMissingCategories). */
  createdCategories: string[];
  /** Stock codes, for a spot check. Capped so the response stays readable. */
  createdSample: string[];
  updatedSample: string[];
}

const SAMPLE_LIMIT = 20;

/**
 * A database constraint the CSV tripped, pinned to the row that tripped it.
 *
 * `products` carries unique indexes the import can violate — `slug` is unique
 * per company, and a spreadsheet can easily carry a slug another product
 * already owns. Without this the whole request 500s and the operator is told
 * nothing about which of 561 rows was at fault.
 */
class ImportRowWriteError extends Error {
  constructor(
    readonly row: number,
    readonly stockCode: string,
    readonly cause: unknown,
  ) {
    super(describeDbError(cause));
    this.name = 'ImportRowWriteError';
  }
}

/** Turn a Postgres error into something an operator can act on. */
function describeDbError(err: unknown): string {
  const e = err as { code?: string; constraint?: string; detail?: string; message?: string };
  if (e?.code === '23505') {
    if (e.constraint?.includes('slug')) {
      return 'Another product already uses this Slug. Slugs must be unique — change it or clear the cell.';
    }
    return `This row duplicates a value another product already has${e.detail ? ` (${e.detail})` : ''}.`;
  }
  if (e?.code === '22001') {
    return 'A value in this row is too long for its column.';
  }
  return e?.message ?? 'The database rejected this row.';
}

/** Numeric columns are `numeric` in Postgres, which drizzle wants as strings. */
const DECIMAL_FIELDS = new Set([
  'expectedNextCost',
  'minSellingPrice',
  'maxSellingPrice',
  'weight',
  'length',
  'width',
  'height',
  'purchasePackSize',
  'purchaseToStockFactor',
  'countQuantum',
]);

function toColumnValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values)) {
    out[field] =
      value !== null && DECIMAL_FIELDS.has(field) ? String(value) : value;
  }
  return out;
}

export class ProductImportService {
  private db = getDb();

  async importCsv(
    text: string,
    opts: ProductImportOptions = {},
    companyId = getSingletonCompanyId(),
  ): Promise<ProductImportResult> {
    const dryRun = opts.dryRun ?? false;
    const parsed = parseProductCsv(text);

    const result: ProductImportResult = {
      dryRun,
      created: 0,
      updated: 0,
      errors: [...parsed.errors],
      ignoredColumns: parsed.ignoredColumns,
      unknownColumns: parsed.unknownColumns,
      createdCategories: [],
      createdSample: [],
      updatedSample: [],
    };

    // ── Resolve item categories before touching products ──────────────────
    // Done up front so an unknown category fails the file rather than being
    // discovered a thousand rows in.
    const existingCategories = await this.db
      .select({ id: itemCategories.id, name: itemCategories.name })
      .from(itemCategories)
      .where(and(eq(itemCategories.companyId, companyId), isNull(itemCategories.deletedAt)));
    const categoryByName = new Map(
      existingCategories.map((c) => [c.name.trim().toLowerCase(), c.id]),
    );

    const wantedCategories = new Set<string>();
    for (const row of parsed.rows) {
      if (row.itemCategoryName) wantedCategories.add(row.itemCategoryName);
    }

    const missingCategories = [...wantedCategories].filter(
      (name) => !categoryByName.has(name.trim().toLowerCase()),
    );

    if (missingCategories.length > 0 && !opts.createMissingCategories) {
      const known = existingCategories.map((c) => c.name).sort();
      for (const row of parsed.rows) {
        const name = row.itemCategoryName;
        if (!name || categoryByName.has(name.trim().toLowerCase())) continue;
        result.errors.push({
          row: row.row,
          stockCode: row.stockCode,
          message:
            `Item category "${name}" does not exist. ` +
            (known.length
              ? `Known categories: ${known.join(', ')}. `
              : 'No item categories have been created yet. ') +
            'Add it on the product page first, or tick "Create missing item categories".',
        });
      }
    }

    // Nothing is written if ANY row is bad — see the class comment.
    if (result.errors.length > 0) {
      result.errors.sort((a, b) => a.row - b.row);
      return result;
    }

    // ── Existing products, by stock code ──────────────────────────────────
    const existingProducts = await this.db
      .select({ id: products.id, stockCode: products.stockCode })
      .from(products)
      .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));
    const productByCode = new Map<string, string>();
    for (const p of existingProducts) {
      if (p.stockCode) productByCode.set(p.stockCode.trim().toLowerCase(), p.id);
    }

    const toCreate: ParsedImportRow[] = [];
    const toUpdate: Array<{ row: ParsedImportRow; id: string }> = [];
    for (const row of parsed.rows) {
      const id = productByCode.get(row.stockCode.toLowerCase());
      if (id) toUpdate.push({ row, id });
      else toCreate.push(row);
    }

    // A create needs a name — an update inherits the one already stored.
    for (const row of toCreate) {
      if (!row.values.name) {
        result.errors.push({
          row: row.row,
          stockCode: row.stockCode,
          message: `No product has stock code "${row.stockCode}", so this row would create one — and a new product needs a Name.`,
        });
      }
    }
    if (result.errors.length > 0) {
      result.errors.sort((a, b) => a.row - b.row);
      return result;
    }

    result.created = toCreate.length;
    result.updated = toUpdate.length;
    result.createdSample = toCreate.slice(0, SAMPLE_LIMIT).map((r) => r.stockCode);
    result.updatedSample = toUpdate.slice(0, SAMPLE_LIMIT).map((r) => r.row.stockCode);
    result.createdCategories = opts.createMissingCategories ? missingCategories : [];

    if (dryRun) return result;

    try {
      await this.applyRows(toCreate, toUpdate, missingCategories, categoryByName, companyId);
    } catch (err) {
      if (err instanceof ImportRowWriteError) {
        // The transaction rolled back, so nothing was written — report it the
        // same way a validation failure is reported.
        return {
          ...result,
          created: 0,
          updated: 0,
          createdCategories: [],
          createdSample: [],
          updatedSample: [],
          errors: [{ row: err.row, stockCode: err.stockCode, message: err.message }],
        };
      }
      throw err;
    }

    return result;
  }

  private async applyRows(
    toCreate: ParsedImportRow[],
    toUpdate: Array<{ row: ParsedImportRow; id: string }>,
    missingCategories: string[],
    categoryByName: Map<string, string>,
    companyId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const name of missingCategories) {
        const [row] = await tx
          .insert(itemCategories)
          .values({ companyId, name: name.trim() })
          .returning({ id: itemCategories.id });
        categoryByName.set(name.trim().toLowerCase(), row!.id);
      }

      const categoryIdFor = (row: ParsedImportRow): string | null | undefined => {
        // undefined -> column absent, leave the product's category alone.
        if (row.itemCategoryName === null) return undefined;
        // '' -> the cell was blanked, which clears the category.
        if (row.itemCategoryName === '') return null;
        return categoryByName.get(row.itemCategoryName.trim().toLowerCase()) ?? null;
      };

      for (const row of toCreate) {
        const categoryId = categoryIdFor(row);
        try {
          await tx.insert(products).values({
            companyId,
            ...toColumnValues(row.values),
            stockCode: row.stockCode,
            ...(categoryId !== undefined ? { itemCategoryId: categoryId } : {}),
          } as typeof products.$inferInsert);
        } catch (err) {
          throw new ImportRowWriteError(row.row, row.stockCode, err);
        }
      }

      for (const { row, id } of toUpdate) {
        const categoryId = categoryIdFor(row);
        try {
          await tx
            .update(products)
            .set({
              ...toColumnValues(row.values),
              ...(categoryId !== undefined ? { itemCategoryId: categoryId } : {}),
              updatedAt: new Date(),
            })
            .where(eq(products.id, id));
        } catch (err) {
          throw new ImportRowWriteError(row.row, row.stockCode, err);
        }
      }
    });
  }

  /** How many live products carry a stock code — context for the import screen. */
  async catalogueSize(companyId = getSingletonCompanyId()): Promise<number> {
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.companyId, companyId), isNull(products.deletedAt)));
    return count;
  }
}
