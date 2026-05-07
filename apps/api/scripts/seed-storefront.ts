/**
 * seed-storefront.ts — seed the Storefront Demo company catalogue from
 * an xlsx export of the inventory system.
 *
 * Reads `.tmp-catalogue.xlsx` at the repo root by default (overridable
 * via `CATALOGUE_XLSX_PATH` env var) and creates:
 *
 *   - One product_groups row per (material + sub-type), e.g.
 *     "Landau PLA Basic 1.75mm 1kg", "Landau Hyper PETG 1.75mm 1kg".
 *     Each group has a written long description (boilerplate per
 *     sub-type) suitable for the storefront PDP.
 *   - One products row per xlsx row, mapped via SKU to the right group.
 *     The colour name + hex come from a small lookup; novel colours
 *     fall back to a neutral grey with a console warning.
 *   - stock_items rows according to the xlsx Stock Available Quantity.
 *     Zero-stock SKUs still get a published product (so they appear in
 *     the catalogue with "Notify me" instead of "Add to cart").
 *
 * Idempotent: wipes the Storefront Demo company's catalogue first and
 * recreates from the xlsx. Other companies are untouched.
 *
 * Run with:
 *   DATABASE_URL=... npm run seed:storefront -w @smmta/api
 *
 * Tests can pass `rows` directly via `seedStorefront({ rows: [...] })`
 * to bypass xlsx reading entirely.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
// xlsx is a CJS-only package (v0.18.x ships no ESM entry). Default-import
// pulls the whole module.exports under one name; we then destructure the
// helpers we need.
import XLSX from 'xlsx';
const { readFile: xlsxReadFile, utils: xlsxUtils } = XLSX;
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  productCategoryMappings,
  productGroups,
  productImages,
  products,
  stockItems,
  warehouses,
} from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

/**
 * Stable identifier for the singleton company. smmta-next is single-tenant
 * per deployment, so this resolves to the deployment's `COMPANY_ID` env
 * var (default `11111111-1111-4111-8111-111111111111`, matching the
 * existing Filament Store production deploy).
 */
export const STOREFRONT_DEMO_COMPANY_ID = getSingletonCompanyId();
export const STOREFRONT_DEMO_COMPANY_NAME = 'Storefront Demo';

// ============================================================
// Material + sub-type taxonomy
// ============================================================

export type MaterialCode = 'PLA' | 'PETG' | 'ABS' | 'ASA' | 'TPU';
export type SubtypeCode =
  | ''
  | 'BAS'
  | 'CF'
  | 'HYP'
  | 'MAT'
  | 'PRO'
  | 'REG'
  | 'SILK' // PLA Silk — silk-finish PLA
  | 'A'; // TPU 95A — softer flexible filament (vs TPU PRO = 98A)

const MATERIAL_LABELS: Record<MaterialCode, string> = {
  PLA: 'PLA',
  PETG: 'PETG',
  ABS: 'ABS',
  ASA: 'ASA',
  TPU: 'TPU',
};

const SUBTYPE_LABELS: Record<SubtypeCode, string> = {
  '': 'Regular',
  REG: 'Regular',
  BAS: 'Basic',
  CF: 'Carbon Fibre',
  HYP: 'Hyper',
  MAT: 'Matte',
  PRO: 'Pro',
  SILK: 'Silk',
  A: '95A',
};

const SUBTYPE_SLUGS: Record<SubtypeCode, string> = {
  '': 'regular',
  REG: 'regular',
  BAS: 'basic',
  CF: 'carbon-fibre',
  HYP: 'hyper',
  MAT: 'matte',
  PRO: 'pro',
  SILK: 'silk',
  A: '95a',
};

/** Group long descriptions, keyed by `${material}-${subtype}`. Sub-types
 *  without a dedicated description fall back to the regular variant. */
const GROUP_LONG_DESCRIPTIONS: Record<string, string> = {
  'PLA-': [
    '## PLA — the workshop staple',
    '',
    'Standard PLA filament. Beginner-friendly, low-warp, prints reliably at 200–220°C',
    'with no enclosure needed. Made from corn starch — rigid, dimensionally accurate,',
    'and inexpensive.',
    '',
    '- 1.75mm diameter, ±0.02mm tolerance',
    '- 1kg spools, vacuum-sealed',
    '- Print temperature: 200–220°C',
    '- Bed temperature: 50–60°C',
    '- No enclosure required',
  ].join('\n'),
  'PLA-REG': [
    '## PLA Regular',
    '',
    'Standard PLA — the everyday filament for prototyping, decorative prints, and',
    "parts that don't need to take heat. Reliable, predictable, and cheap.",
    '',
    '- 1.75mm diameter, ±0.02mm tolerance',
    '- 1kg spools',
    '- Print: 200–220°C bed 50–60°C',
  ].join('\n'),
  'PLA-BAS': [
    '## PLA Basic',
    '',
    'Entry-level PLA at the value end of our range. For high-volume printing where',
    "cost per gram matters more than premium tolerances.",
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 200–220°C',
  ].join('\n'),
  'PLA-PRO': [
    '## PLA+ / PLA Pro',
    '',
    'Enhanced PLA with improved layer adhesion and impact resistance compared to',
    'regular PLA. Slightly higher print temperature (210–230°C) for better mechanical',
    'properties — useful for functional prints that need to take some abuse.',
    '',
    '- 1.75mm diameter, tight tolerances',
    '- 1kg spools',
    '- Print: 210–230°C bed 50–60°C',
  ].join('\n'),
  'PLA-MAT': [
    '## PLA Matte',
    '',
    'Matte-finish PLA produces flat, non-glossy surfaces straight off the printer.',
    'Hides layer lines much better than glossy PLA — popular for figures, miniatures,',
    'and display models.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 200–220°C',
  ].join('\n'),
  'PLA-HYP': [
    '## Hyper PLA+',
    '',
    'High-speed PLA, formulated for printers running at 300mm/s or higher. Maintains',
    'print quality at speeds where standard PLA would string or under-extrude.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 200–230°C, optimised for speed',
  ].join('\n'),
  'PLA-CF': [
    '## PLA Carbon Fibre',
    '',
    'PLA blended with chopped carbon fibre — stronger and stiffer than regular PLA,',
    'with a distinctive matte black finish. Hardened nozzle (0.4mm hardened steel)',
    'strongly recommended; CF will wear brass nozzles quickly.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 210–230°C',
    '- Hardened nozzle required',
  ].join('\n'),
  'PETG-': [
    '## PETG — durable and food-safe',
    '',
    'PETG is stronger than PLA, more impact-resistant, and food-safe. Prints at',
    '220–240°C without an enclosure. Great for functional prints, water-tight',
    'containers, and parts that need to flex without snapping.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 220–240°C bed 70–80°C',
  ].join('\n'),
  'PETG-REG': [
    '## PETG Regular',
    '',
    'Durable, flexible, food-safe filament — stronger than PLA and more impact-',
    'resistant. Prints at 220–240°C with no enclosure needed.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 220–240°C bed 70–80°C',
  ].join('\n'),
  'PETG-PRO': [
    '## PETG Pro',
    '',
    'High-quality PETG with tighter tolerances and improved layer adhesion. For',
    'functional prints needing dimensional accuracy and clean surfaces.',
    '',
    '- 1.75mm diameter, tight tolerances',
    '- 1kg spools',
    '- Print: 220–240°C',
  ].join('\n'),
  'PETG-HYP': [
    '## Hyper PETG',
    '',
    'High-speed PETG for printers running at 300mm/s or higher. Maintains layer',
    'adhesion and surface quality at speed.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 220–250°C, optimised for speed',
  ].join('\n'),
  'PETG-CF': [
    '## PETG Carbon Fibre',
    '',
    'PETG blended with chopped carbon fibre. Stronger and stiffer than regular PETG,',
    'with a matte black finish. Hardened nozzle required.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 230–250°C',
    '- Hardened nozzle required',
  ].join('\n'),
  'ABS-': [
    '## ABS — engineering plastic',
    '',
    'Heat-resistant, impact-tough, machineable. Requires an enclosure to print',
    'without warping, plus a heated bed at 90–110°C.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 230–250°C bed 90–110°C',
    '- Enclosure required',
  ].join('\n'),
  'ABS-REG': [
    '## ABS Regular',
    '',
    'Heat-resistant, impact-tough engineering plastic. Requires a heated bed and an',
    'enclosure to prevent warping. Print at 230–250°C.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Enclosure required',
  ].join('\n'),
  'ABS-CF': [
    '## ABS Carbon Fibre',
    '',
    'ABS reinforced with chopped carbon fibre. Stiffer, more dimensionally stable,',
    'and more heat-resistant than regular ABS. Hardened nozzle required.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 240–260°C',
    '- Hardened nozzle + enclosure required',
  ].join('\n'),
  'ABS-HYP': [
    '## Hyper ABS',
    '',
    'High-speed ABS for fast printing. Same enclosure / heated bed requirements as',
    'regular ABS.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 240–260°C, optimised for speed',
  ].join('\n'),
  'ASA-': [
    '## ASA — UV-stable engineering plastic',
    '',
    "Like ABS but doesn't yellow or crack outdoors. For garden, automotive, and any",
    'UV-exposed prints. Heat-resistant and impact-tough. Enclosure recommended.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 240–260°C bed 90–110°C',
    '- Enclosure recommended',
  ].join('\n'),
  'ASA-REG': [
    '## ASA',
    '',
    "UV-stable engineering plastic. Like ABS but doesn't yellow or crack outdoors.",
    'For garden furniture, automotive trim, and any UV-exposed prints.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 240–260°C',
    '- Enclosure recommended',
  ].join('\n'),
  'TPU-': [
    '## TPU — flexible filament',
    '',
    'Bendy, rubber-like, great for grips, phone cases, gaskets, and hinges. Print',
    'slowly (20–40mm/s) on a direct-drive extruder; bowden setups struggle.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 220–240°C bed 50–60°C',
    '- Direct-drive extruder strongly recommended',
  ].join('\n'),
  'TPU-PRO': [
    '## TPU Pro 98A',
    '',
    "Higher-quality TPU at 98A shore hardness — firmer than basic TPU, easier to",
    'print, still flexible enough for grips, hinges, and shock-absorbing parts.',
    'Print slowly on direct-drive extruders.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 220–240°C',
    '- Direct-drive extruder recommended',
  ].join('\n'),
  'TPU-A': [
    '## TPU 95A',
    '',
    'Softer flexible filament at 95A shore hardness — the rubbery, bendy end of the',
    'TPU range. For grips, gaskets, phone cases, and anything that needs to flex.',
    'Print slowly (20–40mm/s) on a direct-drive extruder.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 220–240°C bed 50–60°C',
    '- Direct-drive extruder strongly recommended',
  ].join('\n'),
  'PLA-SILK': [
    '## PLA Silk',
    '',
    'Silk-finish PLA produces a glossy, satin-like surface with a metallic sheen.',
    'Catches the light beautifully — popular for jewellery, decorative pieces, and',
    'show models.',
    '',
    '- 1.75mm diameter',
    '- 1kg spools',
    '- Print: 200–220°C',
    '- Slower speeds give a better silk finish',
  ].join('\n'),
};

// ============================================================
// Colour map: SKU/sheet colour token → display name + hex
// ============================================================

const COLOUR_MAP: Record<string, { display: string; hex: string }> = {
  BLACK: { display: 'Black', hex: '#1a1a1a' },
  BLUE: { display: 'Blue', hex: '#1d6fda' },
  BROWN: { display: 'Brown', hex: '#7a4520' },
  GREEN: { display: 'Green', hex: '#13a386' },
  GREY: { display: 'Grey', hex: '#9aa0a6' },
  GRAY: { display: 'Grey', hex: '#9aa0a6' },
  ORANGE: { display: 'Orange', hex: '#e88f1d' },
  PINK: { display: 'Pink', hex: '#f3a8c7' },
  PURPLE: { display: 'Purple', hex: '#7d3ad4' },
  RED: { display: 'Red', hex: '#d63131' },
  YELLOW: { display: 'Yellow', hex: '#f3c41a' },
  WHITE: { display: 'White', hex: '#f5f5f5' },
  BEIGE: { display: 'Beige', hex: '#d9c8a3' },
  CLEAR: { display: 'Clear', hex: '#e6f0f5' },
  TRANSPARENT: { display: 'Transparent', hex: '#e6f0f5' },
  GOLD: { display: 'Gold', hex: '#c9a234' },
  SILVER: { display: 'Silver', hex: '#c0c5cc' },
  ROSE: { display: 'Rose', hex: '#cf6e7a' },
  SAND: { display: 'Sand', hex: '#cfae7e' },
  MAROON: { display: 'Maroon', hex: '#7a1f2c' },
  'NAVY BLUE': { display: 'Navy Blue', hex: '#1a2a52' },
  'ROYAL BLUE': { display: 'Royal Blue', hex: '#1c4dba' },
  'SKY BLUE': { display: 'Sky Blue', hex: '#7cc4e6' },
  'FIRE ENGINE RED': { display: 'Fire Engine Red', hex: '#cb1c1c' },
  'GREY/BLACK': { display: 'Grey/Black', hex: '#3a3f44' },
};

function lookupColour(rawColour: string): { display: string; hex: string; slug: string } {
  const cleaned = rawColour.trim().toUpperCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
  const found = COLOUR_MAP[cleaned];
  if (found) {
    return {
      display: found.display,
      hex: found.hex,
      slug: found.display
        .toLowerCase()
        .replace(/\//g, '-')
        .replace(/\s+/g, '-'),
    };
  }
  // Fallback for unknown colours: title-case, neutral grey hex.
  // Logged once so unfamiliar names surface in the seed run.
  const title = cleaned.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  // eslint-disable-next-line no-console
  console.warn(
    `[seed:storefront] unknown colour '${rawColour}' — using fallback grey hex; add to COLOUR_MAP to fix.`,
  );
  return {
    display: title,
    hex: '#6b6e76',
    slug: title.toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-'),
  };
}

// ============================================================
// SKU parsing
// ============================================================

interface ParsedSku {
  material: MaterialCode;
  subtype: SubtypeCode;
  colourSku: string;
}

/** Parse `V3-{MAT}-{SUB?}-{COLOUR}{trailingDigits?}` into its parts. */
export function parseSku(sku: string): ParsedSku | null {
  // Note: list ordering matters — `SILK` and `A` come last so they don't shadow
  // the more common subtypes during the alternation match.
  const re =
    /^V3-(PLA|PETG|ABS|ASA|TPU)(?:-(BAS|CF|HYP|MAT|PRO|REG|SILK|A))?-(.+?)(\d*)$/;
  const m = re.exec(sku.trim());
  if (!m) return null;
  return {
    material: m[1] as MaterialCode,
    subtype: ((m[2] ?? '') as SubtypeCode),
    colourSku: m[3].trim(),
  };
}

// ============================================================
// Group naming + slug
// ============================================================

/**
 * Normalise a parsed subtype so that "no subtype" and explicit "REG" (regular)
 * map to the same canonical value. Keeps grouping deterministic when both
 * `V3-ABS-BLACK` (no subtype) and `V3-ABS-REG-BLUE` (explicit REG) appear.
 */
function canonicalSubtype(subtype: SubtypeCode): SubtypeCode {
  return subtype === '' ? 'REG' : subtype;
}

export function groupKey(material: MaterialCode, subtype: SubtypeCode): string {
  return `${material}-${canonicalSubtype(subtype)}`;
}

export function groupName(material: MaterialCode, subtype: SubtypeCode): string {
  const matLabel = MATERIAL_LABELS[material];
  const sub = canonicalSubtype(subtype);
  // "Hyper" reads better as a prefix than a suffix.
  if (sub === 'HYP') return `Landau Hyper ${matLabel} 1.75mm 1kg`;
  if (sub === 'REG') return `Landau ${matLabel} 1.75mm 1kg`;
  const subLabel = SUBTYPE_LABELS[sub];
  return `Landau ${matLabel} ${subLabel} 1.75mm 1kg`;
}

export function groupSlug(material: MaterialCode, subtype: SubtypeCode): string {
  const matSlug = material.toLowerCase();
  const sub = canonicalSubtype(subtype);
  const subSlug = SUBTYPE_SLUGS[sub];
  if (sub === 'REG') return `landau-${matSlug}-1-75mm-1kg`;
  return `landau-${matSlug}-${subSlug}-1-75mm-1kg`;
}

function groupLongDescription(material: MaterialCode, subtype: SubtypeCode): string {
  const key = groupKey(material, subtype);
  return GROUP_LONG_DESCRIPTIONS[key] ?? GROUP_LONG_DESCRIPTIONS[`${material}-`] ?? '';
}

function groupShortDescription(material: MaterialCode, subtype: SubtypeCode): string {
  const matLabel = MATERIAL_LABELS[material];
  const subLabel = SUBTYPE_LABELS[subtype];
  if (subtype === '' || subtype === 'REG') {
    return `Landau ${matLabel} 1.75mm 1kg — multiple colours, vacuum-sealed, fast UK delivery.`;
  }
  if (subtype === 'HYP') {
    return `Hyper ${matLabel} 1.75mm — high-speed printing without sacrificing surface quality.`;
  }
  return `Landau ${matLabel} ${subLabel} 1.75mm 1kg — premium 3D printer filament.`;
}

// ============================================================
// Catalogue row type — what we get out of the xlsx
// ============================================================

export interface CatalogueRow {
  stockCode: string;
  manufacturer: string;
  fullyQualifiedName: string;
  oldGroupId: number | null;
  description: string;
  netWeight: number;
  shippingWeight: number;
  dimensionH: number;
  dimensionW: number;
  dimensionD: number;
  measurementUnit: string;
  sellingPrice: number;
  expectedNextCost: number;
  rawColour: string;
  stockQty: number;
  imageUrl: string | null;
}

const XLSX_COLUMN_MAP = {
  stockCode: 'Stock Code',
  manufacturer: 'Manufacturer',
  fullyQualifiedName: 'Fully Qualified Name',
  oldGroupId: 'ProductGroupId',
  description: 'Product Description',
  netWeight: 'Net Weight',
  shippingWeight: 'Shipping Weight',
  dimensionH: 'Dimension - H',
  dimensionW: 'Dimension - W',
  dimensionD: 'Dimension - D',
  measurementUnit: 'Measurement Unit',
  sellingPrice: 'Main Selling Price',
  expectedNextCost: 'Expected Next Cost',
  rawColour: 'Color',
  stockQty: 'Stock Available Quantity',
  imageUrl: 'Image 1',
} as const;

export function readCatalogueXlsx(filePath: string): CatalogueRow[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Catalogue xlsx not found at ${filePath}. Set CATALOGUE_XLSX_PATH or place the file there.`,
    );
  }
  const wb = xlsxReadFile(filePath);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Catalogue xlsx has no sheets');
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Catalogue xlsx sheet '${sheetName}' is empty`);
  const rawRows = xlsxUtils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });

  return rawRows
    .map((r): CatalogueRow | null => {
      const stockCode = String(r[XLSX_COLUMN_MAP.stockCode] ?? '').trim();
      if (!stockCode) return null;
      return {
        stockCode,
        manufacturer: String(r[XLSX_COLUMN_MAP.manufacturer] ?? 'Landau').trim(),
        fullyQualifiedName: String(r[XLSX_COLUMN_MAP.fullyQualifiedName] ?? '').trim(),
        oldGroupId: numberOrNull(r[XLSX_COLUMN_MAP.oldGroupId]),
        description: String(r[XLSX_COLUMN_MAP.description] ?? '').trim(),
        netWeight: Number(r[XLSX_COLUMN_MAP.netWeight] ?? 1),
        shippingWeight: Number(r[XLSX_COLUMN_MAP.shippingWeight] ?? 1.3),
        dimensionH: Number(r[XLSX_COLUMN_MAP.dimensionH] ?? 19),
        dimensionW: Number(r[XLSX_COLUMN_MAP.dimensionW] ?? 19),
        dimensionD: Number(r[XLSX_COLUMN_MAP.dimensionD] ?? 7),
        measurementUnit: String(r[XLSX_COLUMN_MAP.measurementUnit] ?? 'cm'),
        sellingPrice: Number(r[XLSX_COLUMN_MAP.sellingPrice] ?? 0),
        expectedNextCost: Number(r[XLSX_COLUMN_MAP.expectedNextCost] ?? 0),
        rawColour: String(r[XLSX_COLUMN_MAP.rawColour] ?? '').trim(),
        stockQty: Math.max(0, Math.floor(Number(r[XLSX_COLUMN_MAP.stockQty] ?? 0))),
        imageUrl: stringOrNull(r[XLSX_COLUMN_MAP.imageUrl]),
      };
    })
    .filter((r): r is CatalogueRow => r !== null);
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function stringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * The xlsx Color column smushes the colour name with the material+sub-type,
 * e.g. `BlackABS Regular`, `BLUEHyper PETG`, `Fire Engine RedPLA Basic`.
 * Strip the trailing material/sub-type to recover just the colour. We use a
 * known set of suffixes; anything unknown is returned as-is.
 */
const COLOUR_TRAILING_SUFFIXES = [
  // Order matters — longer/more specific suffixes first so they match before
  // their shorter prefixes (e.g. `PLA Silk` before `PLA`).
  'PLA Basic',
  'PLA Matte',
  'PLA Silk',
  'PLA+/ Pro',
  'PLA Hyper',
  'PLA CF',
  'PLA regular',
  'Hyper PLA+',
  'PLA',
  'PETG-CF',
  'Hyper PETG',
  'PETG Pro',
  'PETG regular',
  'PETG',
  'ABS Regular',
  'ABS regular',
  'ABS CF',
  'Hyper ABS',
  'ABS',
  'ASA',
  'TPU Pro 98A',
  'TPU 95A',
  'TPU',
];

function extractColourFromSheetCell(raw: string): string {
  const r = raw.trim();
  for (const suffix of COLOUR_TRAILING_SUFFIXES) {
    if (r.endsWith(suffix)) return r.slice(0, r.length - suffix.length).trim();
  }
  return r;
}

// ============================================================
// Seed result + main function
// ============================================================

export interface SeedResult {
  companyId: string;
  groupCount: number;
  variantCount: number;
  warehouseId: string;
  stockItemsCreated: number;
}

interface SeedOptions {
  /** If provided, bypass xlsx reading entirely (used by tests). */
  rows?: CatalogueRow[];
}

export async function seedStorefront(opts: SeedOptions = {}): Promise<SeedResult> {
  const xlsxPath =
    process.env.CATALOGUE_XLSX_PATH ??
    path.resolve(process.cwd(), '../../.tmp-catalogue.xlsx');

  const rows = opts.rows ?? readCatalogueXlsx(xlsxPath);
  if (rows.length === 0) throw new Error('Catalogue is empty — nothing to seed');

  // eslint-disable-next-line no-console
  console.log(`[seed:storefront] ${rows.length} rows from catalogue, parsing…`);

  // Parse + group rows by (material, subtype). Skip rows with unparseable SKUs
  // but log them so the operator notices.
  type ParsedRow = CatalogueRow & ParsedSku & { colour: ReturnType<typeof lookupColour> };
  const parsedRows: ParsedRow[] = [];
  for (const r of rows) {
    const parsed = parseSku(r.stockCode);
    if (!parsed) {
      // eslint-disable-next-line no-console
      console.warn(`[seed:storefront] skipping unparseable SKU '${r.stockCode}'`);
      continue;
    }
    const rawColour = r.rawColour
      ? extractColourFromSheetCell(r.rawColour)
      : parsed.colourSku;
    const colour = lookupColour(rawColour);
    parsedRows.push({ ...r, ...parsed, colour });
  }
  if (parsedRows.length === 0) throw new Error('No parseable SKUs in catalogue');

  // Dedupe: at most one variant per (group, colour). The spreadsheet has
  // legacy duplicates like `V3-PETG-REG-BLACK` and `V3-PETG-REG-BLACK1` —
  // same colour, different stock-system entries. The trailing-digit stripping
  // in `parseSku` collapses them to the same colour slug, so we'd hit a
  // unique-index violation on the products table without a dedup pass.
  //
  // Strategy: prefer the SKU with higher stock; tie-break on the
  // lexicographically smaller stockCode (which puts non-suffixed before
  // `-1`/`-2` variants). Logged so the operator can see what was dropped.
  const dedupKey = (pr: ParsedRow): string =>
    `${groupSlug(pr.material, pr.subtype)}::${pr.colour.slug}`;
  const deduped = new Map<string, ParsedRow>();
  let droppedDups = 0;
  for (const pr of parsedRows) {
    const key = dedupKey(pr);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, pr);
      continue;
    }
    // Choose between existing and pr.
    const prWins =
      pr.stockQty > existing.stockQty ||
      (pr.stockQty === existing.stockQty && pr.stockCode < existing.stockCode);
    const winner = prWins ? pr : existing;
    const loser = prWins ? existing : pr;
    // eslint-disable-next-line no-console
    console.warn(
      `[seed:storefront] dedup: dropped ${loser.stockCode} (stock=${loser.stockQty}) in favour of ${winner.stockCode} (stock=${winner.stockQty}) — same group+colour`,
    );
    deduped.set(key, winner);
    droppedDups++;
  }
  const dedupedParsedRows = [...deduped.values()];
  if (droppedDups > 0) {
    // eslint-disable-next-line no-console
    console.log(`[seed:storefront] dedup removed ${droppedDups} duplicate row(s); ${dedupedParsedRows.length} unique variants will be inserted`);
  }

  // Build a deterministic ordering of groups (by material, then subtype).
  const MATERIAL_ORDER: MaterialCode[] = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU'];
  const SUBTYPE_ORDER: SubtypeCode[] = [
    '', 'REG', 'BAS', 'PRO', 'MAT', 'SILK', 'HYP', 'CF', 'A',
  ];

  type GroupBucket = {
    material: MaterialCode;
    subtype: SubtypeCode;
    rows: ParsedRow[];
    sortIndex: number;
  };
  const buckets = new Map<string, GroupBucket>();
  for (const pr of dedupedParsedRows) {
    const key = groupKey(pr.material, pr.subtype);
    let bucket = buckets.get(key);
    if (!bucket) {
      const sortIndex =
        MATERIAL_ORDER.indexOf(pr.material) * 10 + SUBTYPE_ORDER.indexOf(pr.subtype);
      bucket = { material: pr.material, subtype: pr.subtype, rows: [], sortIndex };
      buckets.set(key, bucket);
    }
    bucket.rows.push(pr);
  }
  const orderedBuckets = [...buckets.values()].sort((a, b) => a.sortIndex - b.sortIndex);

  // eslint-disable-next-line no-console
  console.log(`[seed:storefront] ${orderedBuckets.length} groups to create:`);
  for (const b of orderedBuckets) {
    // eslint-disable-next-line no-console
    console.log(`  ${groupName(b.material, b.subtype)} (${b.rows.length} variants)`);
  }

  const db = getDb();
  const companyId = STOREFRONT_DEMO_COMPANY_ID;

  return db.transaction(async (tx) => {
    // -------- 1. Wipe existing storefront data for this company --------
    const productIds = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.companyId, companyId));

    if (productIds.length > 0) {
      const ids = productIds.map((r) => r.id);
      await tx.delete(stockItems).where(inArray(stockItems.productId, ids));
      await tx.delete(productImages).where(inArray(productImages.productId, ids));
      await tx
        .delete(productCategoryMappings)
        .where(inArray(productCategoryMappings.productId, ids));
      await tx.delete(products).where(inArray(products.id, ids));
    }
    await tx.delete(productGroups).where(eq(productGroups.companyId, companyId));
    await tx.delete(warehouses).where(eq(warehouses.companyId, companyId));

    // -------- 2. Warehouse --------
    const [warehouse] = await tx
      .insert(warehouses)
      .values({
        companyId,
        name: 'Demo Warehouse',
        addressLine1: '1 Demo Way',
        city: 'London',
        postCode: 'SW1A 1AA',
        country: 'GB',
        isDefault: true,
      })
      .returning();
    if (!warehouse) throw new Error('Failed to insert demo warehouse');

    // -------- 3. Insert groups --------
    const insertedGroups = await tx
      .insert(productGroups)
      .values(
        orderedBuckets.map((b, idx) => {
          const firstRowImage = b.rows.find((r) => r.imageUrl)?.imageUrl ?? null;
          const matLabel = MATERIAL_LABELS[b.material];
          const seoTitle = `${groupName(b.material, b.subtype)} | Filament Store`.slice(0, 70);
          const seoDescription = (
            `${groupName(b.material, b.subtype)} from ${b.rows.length} colours. 1kg spools, fast UK delivery.`
          ).slice(0, 160);
          return {
            companyId,
            name: groupName(b.material, b.subtype),
            description: groupShortDescription(b.material, b.subtype),
            groupType: 'STOREFRONT' as const,
            slug: groupSlug(b.material, b.subtype),
            shortDescription: groupShortDescription(b.material, b.subtype),
            longDescription: groupLongDescription(b.material, b.subtype),
            heroImageUrl: firstRowImage,
            galleryImageUrls: [],
            seoTitle,
            seoDescription,
            seoKeywords: [
              `${matLabel} filament`,
              `${matLabel} 1.75mm`,
              '3D printer filament',
              `Landau ${matLabel}`,
            ],
            isPublished: true,
            sortOrder: idx,
            // Preserve the legacy ProductGroupId from the spreadsheet.
            oldId: b.rows.find((r) => r.oldGroupId !== null)?.oldGroupId ?? null,
          };
        }),
      )
      .returning({ id: productGroups.id, slug: productGroups.slug });

    // Map group slug → id for variant insert.
    const slugToGroupId = new Map<string, string>();
    for (const g of insertedGroups) slugToGroupId.set(g.slug ?? '', g.id);

    // -------- 4. Insert variants --------
    type VariantInput = typeof products.$inferInsert;
    const variantInputs: VariantInput[] = [];
    const variantSortInGroup: Record<string, number> = {};
    for (const b of orderedBuckets) {
      const gSlug = groupSlug(b.material, b.subtype);
      const gId = slugToGroupId.get(gSlug);
      if (!gId) throw new Error(`Internal: group ${gSlug} was not inserted`);
      // Sort variants alphabetically by colour for predictable display.
      const sortedRows = [...b.rows].sort((x, y) =>
        x.colour.display.localeCompare(y.colour.display),
      );
      for (const r of sortedRows) {
        const idx = variantSortInGroup[gSlug] ?? 0;
        variantSortInGroup[gSlug] = idx + 1;
        const variantSlug = `${gSlug}-${r.colour.slug}`;
        const priceStr = r.sellingPrice.toFixed(2);
        const costStr = r.expectedNextCost.toFixed(2);
        variantInputs.push({
          companyId,
          name: `${groupName(b.material, b.subtype)} — ${r.colour.display}`,
          stockCode: r.stockCode,
          description: r.fullyQualifiedName || r.description,
          expectedNextCost: costStr,
          minSellingPrice: priceStr,
          maxSellingPrice: priceStr,
          productType: 'PHYSICAL' as const,
          weight: String(r.netWeight),
          length: String(r.dimensionD),
          width: String(r.dimensionW),
          height: String(r.dimensionH),
          // Storefront fields:
          groupId: gId,
          colour: r.colour.display,
          colourHex: r.colour.hex,
          slug: variantSlug,
          shortDescription: `${groupName(b.material, b.subtype)} in ${r.colour.display}.`,
          heroImageUrl: r.imageUrl,
          galleryImageUrls: r.imageUrl ? [r.imageUrl] : [],
          seoTitle: `${groupName(b.material, b.subtype)} — ${r.colour.display}`.slice(0, 70),
          seoDescription: (
            `${groupName(b.material, b.subtype)} in ${r.colour.display}. 1kg spool, free UK delivery.`
          ).slice(0, 160),
          seoKeywords: [
            `${MATERIAL_LABELS[b.material]} ${r.colour.display}`,
            `Landau ${MATERIAL_LABELS[b.material]}`,
            '1.75mm filament',
          ],
          isPublished: true,
          sortOrderInGroup: idx,
        });
      }
    }
    const variantRows = await tx
      .insert(products)
      .values(variantInputs)
      .returning({ id: products.id, stockCode: products.stockCode });

    // Map stockCode → product id for stock_items insert.
    const stockCodeToProductId = new Map<string, string>();
    for (const v of variantRows) {
      if (v.stockCode) stockCodeToProductId.set(v.stockCode, v.id);
    }

    // -------- 5. Stock items --------
    type StockInput = typeof stockItems.$inferInsert;
    const stockRows: StockInput[] = [];
    for (const r of dedupedParsedRows) {
      const productId = stockCodeToProductId.get(r.stockCode);
      if (!productId) continue;
      const value = r.expectedNextCost > 0 ? r.expectedNextCost.toFixed(2) : '0.00';
      for (let i = 0; i < r.stockQty; i++) {
        stockRows.push({
          companyId,
          productId,
          warehouseId: warehouse.id,
          quantity: 1,
          status: 'IN_STOCK' as const,
          value,
          currencyCode: 'GBP',
        });
      }
    }
    if (stockRows.length > 0) {
      await tx.insert(stockItems).values(stockRows);
    }

    return {
      companyId,
      groupCount: insertedGroups.length,
      variantCount: variantRows.length,
      warehouseId: warehouse.id,
      stockItemsCreated: stockRows.length,
    };
  });
}

// ============================================================
// CLI entry point
// ============================================================

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
        `[seed:storefront] OK — company=${result.companyId} groups=${result.groupCount} variants=${result.variantCount} warehouse=${result.warehouseId} stockItems=${result.stockItemsCreated}`,
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
