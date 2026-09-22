/**
 * Reads a product CSV into rows the importer can write. Pure: no database.
 *
 * The column layout is the one the previous generation of this system
 * produced from its product download, so a business moving across imports
 * the file it already has. Headings are matched after lowercasing and
 * dropping everything but letters and digits, and most have plainer
 * aliases, so a hand-made sheet with `SKU, Name, Price` works too.
 *
 *   Column (export heading)                → product field
 *   ───────────────────────                  ─────────────
 *   Stock Code | SKU | Product Code          stock code (required, unique)
 *   Fully Qualified Name | Variant Name      name; falls back to Product Name
 *   Product Name | Name | Range Name         the range shared by variants
 *   ProductGroupId | Group Id                which rows belong together
 *   Manufacturer | Brand                     manufacturer (created if new) and brand;
 *                                            ignored when it repeats the stock code
 *   Product Description | Description        description
 *   Net Weight | Weight | Weight (kg)        weight in kg
 *   Dimension - H / W / D | Height/Width/Depth   height, width, length, in cm
 *   Measurement Unit | Dimension Unit        cm (default), mm or in, converted to cm
 *   EAN Code | EAN | Barcode                 EAN, kept only when it is 8, 12, 13 or 14 digits
 *   Main Selling Price | Selling Price | Price    min and max selling price
 *   Expected Next Cost | Next Cost | Cost    expected next cost
 *   Manufactures Part Number | MPN           manufacturer part number
 *   Product Type                             Physical or Service
 *   Enter Serial Numbers at Book in | Require Serial Number   Yes/No
 *   Require Batch Number                     Yes/No
 *   Color | Colour                           colour
 *   HS Code                                  HS code
 *   Seller Integration SKU, Integration SKU 2…10   marketplace seller SKUs
 *   Image 1…5 | Image URL                    images, first is the hero
 *   Text Tag 1…3                             classification hints for the range
 *
 * Columns the export carries but this system has no home for are ignored:
 * price-setting method, margin and rounding, stock levels (stock is booked
 * in through goods received, or reconciled with the stocktake import),
 * minimum and preferred stock, item status, release and discontinuation
 * dates, unit of measure, shipping weight.
 */
import { parseCsvRows } from '../../shared/utils/csv.js';

export interface ParsedProductRow {
  line: number;
  stockCode: string;
  name: string;
  rangeName: string;
  /** Rows sharing this belong to one range: the export's group id, else the range name. */
  groupKey: string;
  oldGroupId: number | null;
  manufacturer: string | null;
  manufacturerPartNumber: string | null;
  description: string | null;
  weightKg: number | null;
  heightCm: number | null;
  widthCm: number | null;
  lengthCm: number | null;
  ean: string | null;
  sellingPrice: number | null;
  expectedNextCost: number | null;
  productType: 'PHYSICAL' | 'SERVICE';
  requireSerialNumber: boolean;
  requireBatchNumber: boolean;
  colour: string | null;
  hsCode: string | null;
  sellerSkus: string[];
  imageUrls: string[];
  tags: string[];
}

export interface ParsedProductsCsv {
  rows: ParsedProductRow[];
  /** Rows that could not be read, with the line number in the file. */
  skipped: Array<{ line: number; stockCode: string | null; reason: string }>;
  /** Normalised headings that were recognised, for the preview. */
  recognisedHeadings: string[];
}

const ALIASES: Record<string, string[]> = {
  stockCode: ['stockcode', 'sku', 'productcode', 'code'],
  fullName: ['fullyqualifiedname', 'variantname', 'fullname'],
  rangeName: ['productname', 'name', 'rangename', 'title'],
  groupId: ['productgroupid', 'groupid'],
  manufacturer: ['manufacturer', 'brand'],
  description: ['productdescription', 'description'],
  weight: ['netweight', 'weight', 'weightkg'],
  height: ['dimensionh', 'height'],
  width: ['dimensionw', 'width'],
  depth: ['dimensiond', 'depth', 'length'],
  unit: ['measurementunit', 'dimensionunit'],
  ean: ['eancode', 'ean', 'barcode', 'gtin'],
  price: ['mainsellingprice', 'sellingprice', 'price'],
  cost: ['expectednextcost', 'nextcost', 'cost', 'costprice'],
  mpn: ['manufacturespartnumber', 'manufacturerpartnumber', 'mpn', 'partnumber'],
  productType: ['producttype', 'type'],
  serial: ['enterserialnumbersatbookinyesno', 'enterserialnumbersatbookin', 'requireserialnumber', 'serialnumbers'],
  batch: ['requirebatchnumberyesno', 'requirebatchnumber', 'batchnumbers'],
  colour: ['color', 'colour'],
  hsCode: ['hscode', 'commoditycode'],
};

const SELLER_SKU_KEYS = ['sellerintegrationsku', ...Array.from({ length: 9 }, (_, i) => `integrationsku${i + 2}`)];
const IMAGE_KEYS = ['image1', 'imageurl', 'image', ...Array.from({ length: 4 }, (_, i) => `image${i + 2}`)];
const TAG_KEYS = ['texttag1', 'texttag2', 'texttag3'];

function pick(row: Record<string, string>, field: keyof typeof ALIASES): string | null {
  for (const key of ALIASES[field]!) {
    const v = row[key];
    if (v !== undefined && v !== '') return v;
  }
  return null;
}

function number(value: string | null): number | null {
  if (value === null) return null;
  const n = parseFloat(value.replace(/[£$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function yes(value: string | null): boolean {
  return /^(y|yes|true|1)$/i.test((value ?? '').trim());
}

/** A GTIN is 8, 12, 13 or 14 digits; anything else is not a barcode and is dropped. */
export function validEan(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\s/g, '');
  return /^\d+$/.test(digits) && [8, 12, 13, 14].includes(digits.length) ? digits : null;
}

/** Centimetres, from the export's measurement unit. Unknown units are read as cm. */
export function toCm(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  const u = (unit ?? 'cm').trim().toLowerCase();
  if (u === 'mm') return Math.round(value * 10) / 100;
  if (u === 'm') return value * 100;
  if (u === 'in' || u === 'inch' || u === 'inches' || u === '"') return Math.round(value * 254) / 100;
  return value;
}

function httpUrl(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  return /^https?:\/\/\S+$/i.test(v) && v.length <= 500 ? v : null;
}

export function parseProductsCsv(csvText: string): ParsedProductsCsv {
  const { keys, rows } = parseCsvRows(csvText);
  const known = new Set([
    ...Object.values(ALIASES).flat(),
    ...SELLER_SKU_KEYS,
    ...IMAGE_KEYS,
    ...TAG_KEYS,
  ]);
  const recognisedHeadings = keys.filter((k) => known.has(k));

  const out: ParsedProductsCsv = { rows: [], skipped: [], recognisedHeadings };
  const seen = new Set<string>();

  for (const { line, values } of rows) {
    const stockCode = pick(values, 'stockCode');
    const rangeName = pick(values, 'rangeName');
    const name = pick(values, 'fullName') ?? rangeName;
    if (!stockCode) {
      out.skipped.push({ line, stockCode: null, reason: 'No stock code' });
      continue;
    }
    if (!name) {
      out.skipped.push({ line, stockCode, reason: 'No product name' });
      continue;
    }
    if (seen.has(stockCode)) {
      out.skipped.push({ line, stockCode, reason: `Stock code repeated in the file` });
      continue;
    }
    seen.add(stockCode);

    const unit = pick(values, 'unit');
    const groupIdRaw = pick(values, 'groupId');
    const oldGroupId = groupIdRaw && /^\d+$/.test(groupIdRaw) ? parseInt(groupIdRaw, 10) : null;
    const typeRaw = (pick(values, 'productType') ?? '').toLowerCase();

    // The previous system wrote the stock code into an unset manufacturer
    // field, so a cell that repeats the row's own code names nobody.
    const manufacturerRaw = pick(values, 'manufacturer');
    const manufacturer = manufacturerRaw && manufacturerRaw.toLowerCase() !== stockCode.toLowerCase() ? manufacturerRaw.slice(0, 120) : null;

    const sellerSkus = [...new Set(SELLER_SKU_KEYS.map((k) => values[k]).filter((v): v is string => !!v))];
    const imageUrls = [...new Set(IMAGE_KEYS.map((k) => httpUrl(values[k])).filter((v): v is string => v !== null))];
    const tags = TAG_KEYS.map((k) => values[k]).filter((v): v is string => !!v);

    out.rows.push({
      line,
      stockCode,
      name: name.slice(0, 500),
      rangeName: (rangeName ?? name).slice(0, 200),
      groupKey: groupIdRaw ? `id:${groupIdRaw}` : `name:${(rangeName ?? name).toLowerCase()}`,
      oldGroupId,
      manufacturer,
      manufacturerPartNumber: pick(values, 'mpn')?.slice(0, 100) ?? null,
      description: pick(values, 'description'),
      weightKg: number(pick(values, 'weight')),
      heightCm: toCm(number(pick(values, 'height')), unit),
      widthCm: toCm(number(pick(values, 'width')), unit),
      lengthCm: toCm(number(pick(values, 'depth')), unit),
      ean: validEan(pick(values, 'ean')),
      sellingPrice: number(pick(values, 'price')),
      expectedNextCost: number(pick(values, 'cost')),
      productType: typeRaw === 'service' ? 'SERVICE' : 'PHYSICAL',
      requireSerialNumber: yes(pick(values, 'serial')),
      requireBatchNumber: yes(pick(values, 'batch')),
      colour: pick(values, 'colour')?.slice(0, 80) ?? null,
      hsCode: pick(values, 'hsCode')?.slice(0, 20) ?? null,
      sellerSkus,
      imageUrls,
      tags,
    });
  }

  return out;
}
