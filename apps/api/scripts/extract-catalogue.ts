/**
 * Turn the operations team's purchasing spreadsheet ("Main List" tab) into the
 * two-file CSV contract the catalogue importer consumes.
 *
 *   npx tsx scripts/extract-catalogue.ts --in=main-list.csv --out-dir=./catalogue
 *
 * Input is the **CSV download of a single tab** (File -> Download -> CSV in
 * Google Sheets). Deliberately not the whole workbook: exporting the workbook
 * concatenates all 8 tabs, each with its own header and column count, which
 * silently corrupts a naive parse (it reports ~942 rows / 107 groups where the
 * Main List actually holds 190 rows / 42 groups).
 *
 * The shape it expects (positional, because columns A and F are BOTH literally
 * headed "SKU" so header-name lookup is ambiguous):
 *
 *   A main SKU · B main product name · C invoice line name · D category
 *   E group id · F supplier SKU · G supplier · H example invoice
 *   I pack size · J unit price · K base unit
 *
 * Outputs (plus a report of everything it could not resolve):
 *   products.csv          one row per MAIN product   (the thing stock is held of)
 *   supplier-products.csv one row per purchased LINE (the thing you order)
 *
 * Grouping: rows sharing a Group ID are one main product. Group ID and main SKU
 * agree 1:1 in the source, so either could key it; Group ID wins because it is
 * what the operations team curate, and a mismatch between the two is reported
 * rather than silently resolved.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as csvParse } from 'csv-parse/sync';

// ── column positions in the Main List tab ────────────────────────────────
const COL = {
  mainSku: 0,
  mainName: 1,
  invoiceName: 2,
  category: 3,
  groupId: 4,
  supplierSku: 5,
  supplier: 6,
  exampleInvoice: 7,
  packSize: 8,
  unitPrice: 9,
  baseUnit: 10,
} as const;

/** Sheet category -> Auto-Stock item_kind. equipment/cleaning have no exact
 *  counterpart in the enum (MERCH/RETAIL/INGREDIENT/PACKAGING); they are
 *  stocked-but-not-sold consumables, so they ride with PACKAGING and every
 *  such row is listed in the report so the bucketing is visible, not silent. */
const CATEGORY_TO_ITEM_KIND: Record<string, string> = {
  ingredient: 'INGREDIENT',
  drink: 'RETAIL',
  packaging: 'PACKAGING',
  equipment: 'PACKAGING',
  cleaning: 'PACKAGING',
  merch: 'MERCH',
  merchandise: 'MERCH',
};

/** Free-text base unit -> a unit the stock ledger can count in. Anything that
 *  is really a *pack size* rather than a unit ("20-Pack") collapses to the
 *  pack unit; the quantity lives on the supplier line, not the main product. */
const BASE_UNIT_MAP: Record<string, string> = {
  l: 'l', litre: 'l', litres: 'l', ltr: 'l',
  ml: 'ml',
  kg: 'kg', kilo: 'kg', kilos: 'kg',
  g: 'g', gram: 'g', grams: 'g',
  each: 'each', unit: 'each', units: 'each', single: 'each',
  slice: 'each',
  pack: 'pack', packs: 'pack',
};

interface Issue {
  row: number;
  kind: string;
  detail: string;
}

interface CliOpts {
  inPath: string;
  outDir: string;
}

function printUsageAndExit(code: number): never {
  console.error(
    'usage: extract-catalogue.ts --in=<main-list.csv> [--out-dir=<dir>]\n' +
      '  --in       CSV download of the "Main List" tab (one tab only)\n' +
      '  --out-dir  where to write products.csv / supplier-products.csv (default ./catalogue-out)',
  );
  process.exit(code);
}

function parseArgs(argv: string[]): CliOpts {
  let inPath = '';
  let outDir = './catalogue-out';
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') printUsageAndExit(0);
    else if (arg.startsWith('--in=')) inPath = arg.slice('--in='.length).trim();
    else if (arg.startsWith('--out-dir=')) outDir = arg.slice('--out-dir='.length).trim();
    else if (arg.startsWith('-')) {
      console.error(`unknown flag: ${arg}`);
      printUsageAndExit(2);
    }
  }
  if (!inPath) {
    console.error('--in=<main-list.csv> is required');
    printUsageAndExit(2);
  }
  return { inPath, outDir };
}

const clean = (v: unknown): string => String(v ?? '').trim();

/** A category value that is plainly a stray product description rather than a
 *  category — the symptom of a shifted row in the source sheet. */
function looksLikeDrift(category: string): boolean {
  return category.length > 24 || /^[A-Z0-9]{10}$/.test(category) || category === ':-:';
}

/** Group IDs in the source are small integers. Anything else means the row has
 *  shifted and the "group id" is really some other cell's contents — which
 *  would otherwise fabricate a phantom main product (a real example: a group id
 *  of "Takeaway Cup Holders for Cars, Prams, Parties, Events, Cafés &
 *  Catering"). Such rows are quarantined, not guessed at. */
function isPlausibleGroupId(groupId: string): boolean {
  return /^\d{1,6}$/.test(groupId);
}

function normaliseBaseUnit(raw: string): { unit: string; note: string | null } {
  const v = raw.trim();
  if (!v) return { unit: 'each', note: 'missing base unit - defaulted to each' };
  const direct = BASE_UNIT_MAP[v.toLowerCase()];
  if (direct) return { unit: direct, note: null };
  // "20-Pack", "10 pack" and friends are a pack SIZE, not a unit of measure.
  if (/pack/i.test(v)) return { unit: 'pack', note: `"${v}" is a pack size, not a unit - used pack` };
  return { unit: 'each', note: `unrecognised base unit "${v}" - defaulted to each` };
}

/** Stable, readable slug for a main product. */
function slugify(sku: string, name: string): string {
  const base = (sku || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `product-${createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
}

function toCsv(rows: Record<string, string>[], headers: string[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => esc(r[h] ?? '')).join(',')),
  ].join('\n');
}

function main(): void {
  const { inPath, outDir } = parseArgs(process.argv.slice(2));
  const raw = readFileSync(inPath, 'utf8');
  const records: string[][] = csvParse(raw, { relaxColumnCount: true, skipEmptyLines: true });

  // Drop the header row(s). The real header has "Group ID" in column E.
  const body = records.filter((r, i) => {
    if (i === 0) return false;
    const a = clean(r[COL.mainSku]);
    return a !== '' && a.toUpperCase() !== 'SKU';
  });

  const issues: Issue[] = [];
  const bucketed: string[] = [];

  // group id -> accumulating main product
  const groups = new Map<
    string,
    { sku: string; name: string; category: string; unit: string; rows: number }
  >();
  const supplierRows: Record<string, string>[] = [];

  body.forEach((r, idx) => {
    const rowNo = idx + 2; // 1-based, +1 for the header
    const groupId = clean(r[COL.groupId]);
    const mainSku = clean(r[COL.mainSku]);
    const mainName = clean(r[COL.mainName]);
    const category = clean(r[COL.category]).toLowerCase();
    const supplier = clean(r[COL.supplier]);
    const supplierSku = clean(r[COL.supplierSku]);

    if (!groupId) {
      issues.push({ row: rowNo, kind: 'no-group-id', detail: `${mainSku} / ${mainName}` });
      return;
    }
    if (!isPlausibleGroupId(groupId)) {
      // Quarantine: emit nothing for this row rather than invent a product.
      issues.push({
        row: rowNo,
        kind: 'QUARANTINED-bad-group-id',
        detail: `${mainSku}: group id is not a number ("${groupId.slice(0, 50)}") - row shifted; fix in the sheet`,
      });
      return;
    }
    if (looksLikeDrift(category)) {
      issues.push({
        row: rowNo,
        kind: 'column-drift',
        detail: `category looks like data: "${category.slice(0, 40)}"`,
      });
    }

    const { unit, note } = normaliseBaseUnit(clean(r[COL.baseUnit]));
    if (note) issues.push({ row: rowNo, kind: 'base-unit', detail: `${mainName}: ${note}` });

    const itemKind = CATEGORY_TO_ITEM_KIND[category] ?? 'INGREDIENT';
    if (category === 'equipment' || category === 'cleaning') {
      const line = `${mainSku} (${category}) -> PACKAGING`;
      if (!bucketed.includes(line)) bucketed.push(line); // per product, not per row
    }

    const existing = groups.get(groupId);
    if (!existing) {
      groups.set(groupId, { sku: mainSku, name: mainName, category: itemKind, unit, rows: 1 });
    } else {
      existing.rows += 1;
      // Conflicts inside a group are reported, never silently resolved: they
      // mean the sheet disagrees with itself about what the main product is.
      if (existing.sku !== mainSku) {
        issues.push({
          row: rowNo,
          kind: 'group-sku-conflict',
          detail: `group ${groupId}: "${existing.sku}" vs "${mainSku}"`,
        });
      }
      if (existing.unit !== unit) {
        issues.push({
          row: rowNo,
          kind: 'group-unit-conflict',
          detail: `group ${groupId} (${existing.sku}): "${existing.unit}" vs "${unit}"`,
        });
      }
    }

    // A purchased line is only orderable if we know who sells it.
    if (!supplier) {
      issues.push({ row: rowNo, kind: 'no-supplier', detail: `${mainSku}: line skipped` });
      return;
    }
    supplierRows.push({
      main_sku: mainSku,
      supplier,
      supplier_sku: supplierSku,
      invoice_name: clean(r[COL.invoiceName]),
      pack_size: clean(r[COL.packSize]),
      unit_price: clean(r[COL.unitPrice]).replace(/[^0-9.]/g, ''),
      example_invoice: clean(r[COL.exampleInvoice]),
    });
    if (!supplierSku) {
      issues.push({
        row: rowNo,
        kind: 'no-supplier-sku',
        detail: `${mainSku} @ ${supplier} - orderable by name only`,
      });
    }
  });

  const productRows = [...groups.entries()].map(([groupId, g]) => ({
    sku: g.sku,
    name: g.name,
    slug: slugify(g.sku, g.name),
    item_kind: g.category,
    stock_uom: g.unit,
    group_id: groupId,
    source_lines: String(g.rows),
  }));

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'products.csv'),
    toCsv(productRows, ['sku', 'name', 'slug', 'item_kind', 'stock_uom', 'group_id', 'source_lines']),
    'utf8',
  );
  writeFileSync(
    join(outDir, 'supplier-products.csv'),
    toCsv(supplierRows, [
      'main_sku', 'supplier', 'supplier_sku', 'invoice_name',
      'pack_size', 'unit_price', 'example_invoice',
    ]),
    'utf8',
  );

  const byKind = issues.reduce<Record<string, number>>((acc, i) => {
    acc[i.kind] = (acc[i.kind] ?? 0) + 1;
    return acc;
  }, {});
  const report = [
    `source            : ${inPath}`,
    `data rows read    : ${body.length}`,
    `main products     : ${productRows.length}`,
    `supplier lines    : ${supplierRows.length}`,
    '',
    'issues by kind:',
    ...Object.entries(byKind).map(([k, n]) => `  ${k.padEnd(22)} ${n}`),
    '',
    ...(bucketed.length
      ? ['equipment/cleaning bucketed as PACKAGING:', ...bucketed.map((b) => `  ${b}`), '']
      : []),
    'issue detail:',
    ...issues.map((i) => `  row ${String(i.row).padStart(4)}  ${i.kind.padEnd(22)} ${i.detail}`),
  ].join('\n');
  writeFileSync(join(outDir, 'extract-report.txt'), report, 'utf8');

  console.log(report.split('\nissue detail:')[0]);
  console.log(`written to ${outDir}/ (products.csv, supplier-products.csv, extract-report.txt)`);
}

main();
