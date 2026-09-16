/**
 * CSV import for the product catalogue — the other half of the Export button.
 *
 * The file format IS the export's format: same headers, same column meanings,
 * so the loop is export → edit in a spreadsheet → import. That is only true if
 * the two definitions cannot drift, so the importable columns are derived from
 * `PRODUCT_EXPORT_COLUMNS` rather than listed again here, and a test asserts it.
 *
 * ── THE RULES, because a bulk write needs them stated ────────────────────────
 *
 * **Key.** `Stock code` (the SKU). A row whose stock code matches a live
 * product UPDATES it; anything else is CREATED. Matching is case-insensitive
 * and trimmed, because a spreadsheet will hand back " FLOUR-01 ".
 *
 * **A missing COLUMN leaves the field alone. An empty CELL clears it.** These
 * have to differ or the format cannot express "remove the pack description".
 * Deleting a column from the sheet is how you say "don't touch this"; blanking
 * a cell is how you say "make this empty". Clearing a NOT NULL field is a row
 * error rather than a silent no-op.
 *
 * **Read-only columns are ignored, and the report says which.** `Product ID`,
 * `Created at`, `Updated at` and the resolved foreign-key names come back out
 * of the export so a person can read the file; writing them would mean
 * inventing suppliers and categories from typos. They are skipped by name, not
 * silently dropped — `ignoredColumns` lists every one that appeared.
 *
 * **Item category is resolved by NAME**, case-insensitively. An unknown name is
 * a row error naming it, unless `createMissingCategories` is set — because the
 * usual cause is a typo, and a typo that silently mints "Dry Stok" splits the
 * catalogue in a way nobody notices until a count sheet comes out wrong.
 */
import { parse as csvParse } from 'csv-parse/sync';
import { PRODUCT_EXPORT_COLUMNS } from './product-export.js';

/** Columns the import will write, by their export `source` key. */
const WRITABLE: ReadonlySet<string> = new Set([
  'name',
  'stockCode',
  'barcode',
  'ean',
  'slug',
  'manufacturerPartNumber',
  'productType',
  'itemKind',
  'isSold',
  'isStocked',
  'isExperienceBooking',
  'isPublished',
  'itemCategoryName',
  'stockUom',
  'purchaseUom',
  'purchasePackSize',
  'packDescription',
  'purchaseToStockFactor',
  'countQuantum',
  'stockCheckInstruction',
  'expectedNextCost',
  'minSellingPrice',
  'maxSellingPrice',
  'weight',
  'length',
  'width',
  'height',
  'countryOfOrigin',
  'hsCode',
  'requireSerialNumber',
  'requireBatchNumber',
  'description',
  'shortDescription',
  'longDescription',
  'colour',
  'colourHex',
  'sortOrderInGroup',
  'heroImageUrl',
  'galleryImageUrls',
  'referenceImageUrl',
  'imageCaptureStore',
  'seoTitle',
  'seoDescription',
  'seoKeywords',
  'bumblebeeProductId',
]);

/** Fields the database will not accept as empty. */
const REQUIRED: ReadonlySet<string> = new Set(['name', 'stockUom']);

const BOOLEAN_FIELDS: ReadonlySet<string> = new Set([
  'isSold',
  'isStocked',
  'isExperienceBooking',
  'isPublished',
  'requireSerialNumber',
  'requireBatchNumber',
]);

const NUMBER_FIELDS: ReadonlySet<string> = new Set([
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
  'sortOrderInGroup',
]);

/** Pipe-separated lists, matching how the export flattens them. */
const LIST_FIELDS: ReadonlySet<string> = new Set(['galleryImageUrls', 'seoKeywords']);

const ENUMS: Record<string, readonly string[]> = {
  productType: ['PHYSICAL', 'SERVICE'],
  itemKind: ['MERCH', 'RETAIL', 'INGREDIENT', 'PACKAGING'],
};

/** Export header -> field key. Built from the export so the two cannot drift. */
export const HEADER_TO_FIELD: ReadonlyMap<string, string> = new Map(
  PRODUCT_EXPORT_COLUMNS.map((c) => [c.header.toLowerCase(), c.source]),
);

export const STOCK_CODE_HEADER = 'Stock code';

export interface ImportRowError {
  /** 1-based row number as the spreadsheet shows it (header is row 1). */
  row: number;
  stockCode: string | null;
  message: string;
}

export interface ParsedImportRow {
  row: number;
  stockCode: string;
  /** Only the fields this row's file actually carried. */
  values: Record<string, unknown>;
  /** Present when the row names an item category; resolved later. */
  itemCategoryName: string | null;
}

export interface ParsedImport {
  rows: ParsedImportRow[];
  errors: ImportRowError[];
  /** Headers present in the file that the import does not write. */
  ignoredColumns: string[];
  /** Headers present in the file that match no export column at all. */
  unknownColumns: string[];
}

export class ProductImportFormatError extends Error {}

function parseBoolean(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(v)) return true;
  if (['false', 'no', 'n', '0'].includes(v)) return false;
  return undefined;
}

/**
 * Parse and validate a product CSV. Pure — touches no database, so every rule
 * above can be asserted directly.
 */
export function parseProductCsv(text: string): ParsedImport {
  // `bom: true` because our own export writes one for Excel's sake, and without
  // this the first header would come back as "﻿Product ID" and not match.
  let records: Record<string, string>[];
  try {
    records = csvParse(text, {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch (err) {
    throw new ProductImportFormatError(
      `That file could not be read as CSV: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (records.length === 0) {
    throw new ProductImportFormatError('That file has a header row but no products in it.');
  }

  const headers = Object.keys(records[0]!);
  const ignoredColumns: string[] = [];
  const unknownColumns: string[] = [];
  /** header -> field, for the columns we will actually write. */
  const active = new Map<string, string>();

  for (const header of headers) {
    const field = HEADER_TO_FIELD.get(header.trim().toLowerCase());
    if (!field) {
      unknownColumns.push(header);
      continue;
    }
    if (!WRITABLE.has(field)) {
      ignoredColumns.push(header);
      continue;
    }
    active.set(header, field);
  }

  if (!headers.some((h) => h.trim().toLowerCase() === STOCK_CODE_HEADER.toLowerCase())) {
    throw new ProductImportFormatError(
      `That file has no "${STOCK_CODE_HEADER}" column. It is the column products are matched on, ` +
        'so without it nothing can be imported. Export the catalogue and edit that file.',
    );
  }

  const rows: ParsedImportRow[] = [];
  const errors: ImportRowError[] = [];
  const seen = new Map<string, number>();

  records.forEach((record, i) => {
    // +2: the header is row 1 and arrays are 0-based, so record 0 is row 2.
    const row = i + 2;
    const stockCode = (record[
      headers.find((h) => h.trim().toLowerCase() === STOCK_CODE_HEADER.toLowerCase())!
    ] ?? '').trim();

    if (!stockCode) {
      errors.push({
        row,
        stockCode: null,
        message: `No ${STOCK_CODE_HEADER}. Every row needs one — it is how a product is matched.`,
      });
      return;
    }

    const key = stockCode.toLowerCase();
    const firstSeen = seen.get(key);
    if (firstSeen !== undefined) {
      errors.push({
        row,
        stockCode,
        message: `${STOCK_CODE_HEADER} "${stockCode}" is also on row ${firstSeen}. Two rows for one product would apply in an arbitrary order — remove one.`,
      });
      return;
    }
    seen.set(key, row);

    const values: Record<string, unknown> = {};
    let itemCategoryName: string | null = null;
    let rowFailed = false;

    for (const [header, field] of active) {
      const raw = record[header];
      if (raw === undefined) continue; // ragged row — column absent here
      const trimmed = raw.trim();

      if (trimmed === '') {
        if (REQUIRED.has(field)) {
          errors.push({
            row,
            stockCode,
            message: `"${header}" is empty, and a product cannot have an empty ${header.toLowerCase()}.`,
          });
          rowFailed = true;
          break;
        }
        if (field === 'itemCategoryName') {
          itemCategoryName = '';
        } else {
          values[field] = null; // empty cell clears the field
        }
        continue;
      }

      if (field === 'itemCategoryName') {
        itemCategoryName = trimmed;
        continue;
      }

      if (BOOLEAN_FIELDS.has(field)) {
        const parsed = parseBoolean(trimmed);
        if (parsed === undefined) {
          errors.push({
            row,
            stockCode,
            message: `"${header}" is "${trimmed}". It must be true or false (yes/no and 1/0 are accepted).`,
          });
          rowFailed = true;
          break;
        }
        values[field] = parsed;
        continue;
      }

      if (NUMBER_FIELDS.has(field)) {
        // Strip a currency symbol and thousands separators: a spreadsheet
        // formats a cost column as "£1,234.50" and the operator did not ask
        // it to.
        const cleaned = trimmed.replace(/[£$€,\s]/g, '');
        const num = Number(cleaned);
        if (!Number.isFinite(num)) {
          errors.push({
            row,
            stockCode,
            message: `"${header}" is "${trimmed}", which is not a number.`,
          });
          rowFailed = true;
          break;
        }
        if (num < 0) {
          errors.push({
            row,
            stockCode,
            message: `"${header}" is ${num}. It cannot be negative.`,
          });
          rowFailed = true;
          break;
        }
        values[field] = field === 'sortOrderInGroup' ? Math.trunc(num) : num;
        continue;
      }

      if (LIST_FIELDS.has(field)) {
        values[field] = trimmed
          .split('|')
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
        continue;
      }

      const allowed = ENUMS[field];
      if (allowed) {
        const upper = trimmed.toUpperCase();
        if (!allowed.includes(upper)) {
          errors.push({
            row,
            stockCode,
            message: `"${header}" is "${trimmed}". It must be one of: ${allowed.join(', ')}.`,
          });
          rowFailed = true;
          break;
        }
        values[field] = upper;
        continue;
      }

      values[field] = trimmed;
    }

    if (!rowFailed) rows.push({ row, stockCode, values, itemCategoryName });
  });

  return { rows, errors, ignoredColumns, unknownColumns };
}
