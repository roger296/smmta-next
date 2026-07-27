/**
 * Turn the June stock-count list (the reconciliation sheet) into products.csv —
 * the catalogue of things venues physically count.
 *
 *   npx tsx scripts/extract-count-list.ts --in=count-list.csv --out-dir=./catalogue
 *
 * Input is the CSV download of the reconciliation sheet:
 *   Count order · Area · Section · Count item · Pack · Supplier · Suggested main SKU
 *
 * Every count line becomes a product, matched or not — you cannot count what
 * does not exist in the system, and the count list is the authority on what is
 * physically on the shelves. Where the operator has confirmed a main SKU that
 * SKU is used (so the count item and the purchasing catalogue converge on one
 * product); otherwise a SKU is derived from the name.
 *
 * ── Units: why almost everything lands on `each` ──────────────────────────
 * The Pack column describes the CONTAINER ("70cl", "25kg", "2000pk"), not the
 * unit a counter works in. A stock-take counts *containers*: bottles of vodka,
 * bags of flour, boxes of napkins — nobody counts 700ml of Absolut. So the
 * default stock_uom is `each`, which is what the count actually produces.
 * Weight/volume units are correct for ingredients decremented by recipe, and
 * those come from the purchasing sheet's explicit Base unit column via
 * --units=<products.csv from extract-catalogue>. Anything else is left as
 * `each` and listed in the report for review rather than guessed from the pack
 * size, because guessing wrong here silently corrupts every future count.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as csvParse } from 'csv-parse/sync';

/** Count-list area -> Auto-Stock item_kind. */
const AREA_TO_ITEM_KIND: Record<string, string> = {
  merchandise: 'MERCH',
  'bar stock': 'RETAIL',
  'cafe stock': 'RETAIL',
  'corporate food': 'INGREDIENT',
  'general ingredients': 'INGREDIENT',
  'creation corner ingredients': 'INGREDIENT',
};

interface CliOpts {
  inPath: string;
  outDir: string;
  unitsPath: string | null;
}

function printUsageAndExit(code: number): never {
  console.error(
    'usage: extract-count-list.ts --in=<count-list.csv> [--out-dir=<dir>] [--units=<products.csv>]\n' +
      '  --in       CSV download of the reconciliation sheet\n' +
      '  --out-dir  output directory (default ./catalogue-out)\n' +
      '  --units    products.csv from extract-catalogue.ts, to inherit real base units',
  );
  process.exit(code);
}

function parseArgs(argv: string[]): CliOpts {
  let inPath = '';
  let outDir = './catalogue-out';
  let unitsPath: string | null = null;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') printUsageAndExit(0);
    else if (arg.startsWith('--in=')) inPath = arg.slice('--in='.length).trim();
    else if (arg.startsWith('--out-dir=')) outDir = arg.slice('--out-dir='.length).trim();
    else if (arg.startsWith('--units=')) unitsPath = arg.slice('--units='.length).trim();
    else if (arg.startsWith('-')) {
      console.error(`unknown flag: ${arg}`);
      printUsageAndExit(2);
    }
  }
  if (!inPath) {
    console.error('--in=<count-list.csv> is required');
    printUsageAndExit(2);
  }
  return { inPath, outDir, unitsPath };
}

const clean = (v: unknown): string => String(v ?? '').trim();

/** The confirmed-SKU cell may be a bare code ("BAKE-CAST-SUGR") or the
 *  "CODE — Product Name" form carried over from the suggestion columns. */
function parseConfirmedSku(raw: string): string {
  const v = clean(raw);
  if (!v) return '';
  const code = v.split(/[—-]{1,2}\s/)[0]!.trim();
  return /^[A-Z0-9][A-Z0-9-]{2,}$/i.test(code) ? code.toUpperCase() : '';
}

/** Derive a stable SKU for an unmatched count item: 3 chunks of up to 4 chars
 *  from its significant words, matching the house style (BAKE-CAST-SUGR). */
function deriveSku(name: string, used: Set<string>): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const parts = words.slice(0, 3).map((w) => w.slice(0, 4));
  while (parts.length < 2) parts.push('ITEM');
  let sku = parts.join('-');
  let n = 2;
  while (used.has(sku)) sku = `${parts.join('-')}-${n++}`;
  used.add(sku);
  return sku;
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);

function toCsv(rows: Record<string, string>[], headers: string[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h] ?? '')).join(','))].join('\n');
}

function main(): void {
  const { inPath, outDir, unitsPath } = parseArgs(process.argv.slice(2));

  // Optional: real base units for SKUs the purchasing sheet has curated.
  const unitBySku = new Map<string, string>();
  if (unitsPath) {
    for (const r of csvParse(readFileSync(unitsPath, 'utf8'), {
      columns: true, skipEmptyLines: true, trim: true,
    }) as Record<string, string>[]) {
      if (r.sku && r.stock_uom) unitBySku.set(r.sku.toUpperCase(), r.stock_uom);
    }
  }

  const rows = csvParse(readFileSync(inPath, 'utf8'), {
    columns: true, skipEmptyLines: true, trim: true,
  }) as Record<string, string>[];

  const usedDerived = new Set<string>();
  const bySku = new Map<
    string,
    { name: string; kind: string; uom: string; areas: Set<string>; matched: boolean; counts: number }
  >();
  const notes: string[] = [];
  let matched = 0;

  for (const r of rows) {
    const name = clean(r['Count item']);
    if (!name) continue;
    const area = clean(r.Area);
    const confirmed = parseConfirmedSku(r['Suggested main SKU'] ?? '');
    const sku = confirmed || deriveSku(name, usedDerived);
    if (confirmed) matched += 1;

    const kind = AREA_TO_ITEM_KIND[area.toLowerCase()] ?? 'INGREDIENT';
    const uom = unitBySku.get(sku) ?? 'each';

    const existing = bySku.get(sku);
    if (!existing) {
      bySku.set(sku, {
        name, kind, uom, areas: new Set([area]), matched: Boolean(confirmed), counts: 1,
      });
    } else {
      existing.counts += 1;
      existing.areas.add(area);
      // Two different count lines resolving to one SKU is usually right (the
      // same item counted in two areas) but sometimes reveals a bad match, so
      // every merge is reported with both names for eyeballing.
      if (existing.name.toLowerCase() !== name.toLowerCase()) {
        notes.push(`MERGED into ${sku}: "${existing.name}" + "${name}"${existing.areas.size > 1 ? ` (areas: ${[...existing.areas].join(' / ')})` : ''}`);
      }
    }
  }

  const products = [...bySku.entries()].map(([sku, p]) => ({
    sku,
    name: p.name,
    slug: slugify(sku),
    item_kind: p.kind,
    stock_uom: p.uom,
    group_id: '',
    source_lines: String(p.counts),
  }));

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'products.csv'),
    toCsv(products, ['sku', 'name', 'slug', 'item_kind', 'stock_uom', 'group_id', 'source_lines']),
    'utf8',
  );

  const inherited = products.filter((p) => p.stock_uom !== 'each').length;
  const byKind = products.reduce<Record<string, number>>((a, p) => {
    a[p.item_kind] = (a[p.item_kind] ?? 0) + 1;
    return a;
  }, {});
  const report = [
    `source           : ${inPath}`,
    `count lines      : ${rows.length}`,
    `products         : ${products.length}`,
    `  with a confirmed main SKU : ${matched}`,
    `  SKU derived from the name : ${rows.length - matched}`,
    `base units       : ${inherited} inherited from the purchasing sheet, ` +
      `${products.length - inherited} defaulted to "each" (review)`,
    `item kinds       : ${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join('  ')}`,
    '',
    `merges (${notes.length}) — two count lines resolving to one product; check the odd ones:`,
    ...notes.map((n) => `  ${n}`),
  ].join('\n');
  writeFileSync(join(outDir, 'count-list-report.txt'), report, 'utf8');
  console.log(report.split('\nmerges (')[0]);
  console.log(`merges: ${notes.length} (see count-list-report.txt)`);
  console.log(`written to ${outDir}/products.csv`);
}

main();
