/**
 * Turn BumbleBee's OCR'd invoice LINES into importable product-supplier mappings.
 *
 *   npx tsx apps/api/scripts/extract-invoice-skus.ts
 *
 * Auto-Stock cannot raise a purchase order for a product it has no supplier
 * code for, and entering them by hand is a couple of thousand codes across
 * nine suppliers. A year of Big Bakes invoices has already been OCR'd into
 * BumbleBee and carries the code on almost every line - Brakes alone is 16,000
 * lines at 0.4% missing. This turns that pile into a CSV somebody can read
 * before any of it reaches the database.
 *
 * INPUT is a captured response set from the BumbleBee MCP tool
 * `bumblebee_invoice_purchase_prices`, committed alongside this script as
 * apps/api/data/invoice-skus/bumblebee-purchase-lines.json, so the extract is
 * reproducible without a BumbleBee API key. Same arrangement, and the same
 * reasons, as extract-invoice-suppliers.py.
 *
 * WHY THE INPUT IS CAPTURED RATHER THAN FETCHED. There is no REST route for
 * this data - `purchase_prices` exists only as an MCP tool, and it ends in
 * `rows[:500]` with no total_count and no offset. A window holding 501 matching
 * lines returns 500 of them and says nothing at all. So the capture is windowed
 * by supplier and date to stay under that cap, any window that came back with
 * exactly 500 rows was DISCARDED rather than used, and this script refuses to
 * run on a file that does not record that the check was made. A silently short
 * supplier catalogue is precisely the failure this is for: the codes that went
 * missing look exactly like items nobody buys.
 *
 * WHAT THIS DOES NOT GIVE YOU. An invoice line proves a supplier billed a code
 * at a price on a date. It does not say which Auto-Stock product that is -
 * matching is import-invoice-skus.ts's job, against the real catalogue, and it
 * reports what it could not place rather than guessing. Nor does a line prove a
 * code is still orderable: one last seen ten months ago may be discontinued.
 *
 * Writes to apps/api/data/invoice-skus/:
 *   supplier-skus.csv         the mappings to import
 *   supplier-skus-review.csv  the ones held back, each with its reason
 *   extract-report.txt        the counts, so a re-run can be diffed
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  codeCore,
  isJunkSku,
  normalisePack,
  packsAgree,
  unitCost,
  type InvoiceLine,
} from '../src/modules/suppliers/invoice-sku-extract.js';
import { csvCell } from '../src/shared/utils/csv.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'invoice-skus');

/**
 * Same firm, typed differently on the invoices. Explicit rather than
 * fuzzy-matched, for the reason extract-invoice-suppliers.py gives: no
 * similarity score knows that "Sysco" and "Brakes" are two businesses despite
 * Sysco owning Brakes. These spellings must match the supplier NAMES already in
 * Auto-Stock - that is what the importer looks them up by.
 */
const SUPPLIER_CANONICAL: Record<string, string> = {
  makro: 'Makro',
  jmposner: 'JMPosner',
  'lwc drinks': 'LWC Drinks',
  sainsburys: "Sainsbury's",
};

function canonicalSupplier(name: string | null): string {
  const n = (name ?? '').trim();
  return SUPPLIER_CANONICAL[n.toLowerCase()] ?? n;
}

export interface SkuMapping {
  supplier: string;
  supplierSku: string;
  aliases: string[];
  description: string;
  packSize: string;
  unitCostGbp: number | null;
  linesSeen: number;
  lastSeen: string;
  minConfidence: number;
  /** Set only when this one is held back. */
  reason?: string;
}

export interface ExtractReport {
  lines: number;
  noSku: number;
  keep: SkuMapping[];
  review: SkuMapping[];
  aliasesFolded: number;
  prefixConflicts: number;
  packConflicts: number;
  priceDisagreements: number;
}

/** Collapse every observation of one code into a single mapping. */
function summarise(
  supplier: string,
  spellings: string[],
  rows: InvoiceLine[],
): { mapping: SkuMapping; disagreed: boolean } {
  const sorted = [...rows].sort((a, b) =>
    (a.invoice_date ?? '').localeCompare(b.invoice_date ?? ''),
  );
  let cost: number | null = null;
  let disagreed = false;
  // Walk backwards: the most recent observation that yields a cost wins, so a
  // price from ten months ago is used only when there is nothing newer.
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const u = unitCost(sorted[i]!);
    if (u.cost != null && u.cost > 0) {
      cost = u.cost;
      disagreed = u.disagreed;
      break;
    }
  }
  const newest = (pick: (l: InvoiceLine) => string | null): string => {
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const v = pick(sorted[i]!);
      if (v) return v;
    }
    return '';
  };
  /**
   * The canonical code is the BARE number whenever the supplier ever billed it
   * that way - that is the code a human reads off a Brakes order form, and the
   * one the operator confirmed is THE SKU. Otherwise the spelling seen most
   * often, so the canonical is at least the supplier's own habit.
   */
  const bare = spellings.filter((s) => codeCore(s)?.prefix === '');
  const freq = (s: string) => rows.filter((r) => (r.sku ?? '').trim() === s).length;
  const canonical =
    bare[0] ?? [...spellings].sort((a, b) => freq(b) - freq(a) || a.localeCompare(b))[0]!;
  return {
    disagreed,
    mapping: {
      supplier,
      supplierSku: canonical,
      aliases: spellings.filter((s) => s !== canonical).sort(),
      description: newest((l) => l.stock_item).replace(/\s+/g, ' ').trim(),
      packSize: newest((l) => l.pack_size).trim(),
      unitCostGbp: cost == null ? null : Math.round(cost * 10_000) / 10_000,
      linesSeen: rows.length,
      lastSeen: newest((l) => l.invoice_date),
      minConfidence: Math.min(...rows.map((r) => r.confidence ?? 0)),
    },
  };
}

/** Group key. An array pair rather than a joined string so no supplier name or
 *  code can collide with the separator. */
type Key = string;
const keyOf = (supplier: string, code: string): Key => JSON.stringify([supplier, code]);
const unkey = (k: Key): [string, string] => JSON.parse(k) as [string, string];

export function extract(lines: InvoiceLine[]): ExtractReport {
  const groups = new Map<Key, InvoiceLine[]>();  // keyed on the numeric core
  const singles = new Map<Key, InvoiceLine[]>(); // codes that are never grouped
  let noSku = 0;

  for (const l of lines) {
    const sku = (l.sku ?? '').trim();
    if (!sku) {
      noSku += 1;
      continue;
    }
    const supplier = canonicalSupplier(l.supplier);
    const core = codeCore(sku);
    const bucket = core ? groups : singles;
    const k = keyOf(supplier, core ? core.digits : sku);
    const at = bucket.get(k);
    if (at) at.push(l);
    else bucket.set(k, [l]);
  }

  const out: ExtractReport = {
    lines: lines.length,
    noSku,
    keep: [],
    review: [],
    aliasesFolded: 0,
    prefixConflicts: 0,
    packConflicts: 0,
    priceDisagreements: 0,
  };

  const emit = (supplier: string, spellings: string[], rows: InvoiceLine[], reason?: string) => {
    const { mapping, disagreed } = summarise(supplier, spellings, rows);
    if (disagreed) out.priceDisagreements += 1;
    if (reason) {
      out.review.push({ ...mapping, reason });
    } else {
      out.aliasesFolded += mapping.aliases.length;
      out.keep.push(mapping);
    }
  };

  const packClash = (rows: InvoiceLine[]): string => {
    const packs = [...new Set(rows.map((r) => normalisePack(r.pack_size)).filter(Boolean))].sort();
    return `seen with ${packs.length} different pack sizes (${packs.join('; ')})`;
  };

  for (const [k, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [supplier, digits] = unkey(k);
    const spellings = [...new Set(rows.map((r) => (r.sku ?? '').trim()))].sort();
    const prefixes = new Set(spellings.map((s) => codeCore(s)!.prefix).filter((p) => p !== ''));

    let reason: string | undefined;
    if (isJunkSku(digits)) {
      reason = `code ${digits} carries no information (a line number, or a misread column rule)`;
    } else if (prefixes.size > 1) {
      /**
       * `A123` and `C123` under one supplier. Not seen once across the captured
       * year, but if it happens the prefix is carrying meaning and merging the
       * two would fuse two products into one. Not a call this script is
       * entitled to make on its own.
       */
      out.prefixConflicts += 1;
      reason =
        `same digits under two different prefixes (${[...prefixes].sort().join(', ')}) ` +
        '- could be two products';
    } else if (!packsAgree(rows.map((r) => r.pack_size))) {
      /**
       * One code, two pack sizes. Usually the OCR dropping a case count -
       * `40 x 250g` read as `250g` - and occasionally the supplier really did
       * change the pack. Either way the pack drives how a PO is rounded, so the
       * error in play is a 40x one and a human picks.
       */
      out.packConflicts += 1;
      reason = packClash(rows);
    } else if (rows.length < 2) {
      reason = 'seen only once in the captured window';
    }
    emit(supplier, spellings, rows, reason);
  }

  for (const [k, rows] of [...singles].sort(([a], [b]) => a.localeCompare(b))) {
    const [supplier, sku] = unkey(k);
    let reason: string | undefined;
    if (isJunkSku(sku)) {
      reason = `code ${sku} carries no information (a line number, or a misread column rule)`;
    } else if (!packsAgree(rows.map((r) => r.pack_size))) {
      out.packConflicts += 1;
      reason = packClash(rows);
    } else if (rows.length < 2) {
      reason = 'seen only once in the captured window';
    }
    emit(supplier, [sku], rows, reason);
  }

  const order = (a: SkuMapping, b: SkuMapping) =>
    a.supplier.localeCompare(b.supplier) || a.supplierSku.localeCompare(b.supplierSku);
  out.keep.sort(order);
  out.review.sort(order);
  return out;
}

export const CSV_HEADER = [
  'supplier',
  'supplier_sku',
  'aliases',
  'description',
  'pack_size',
  'unit_cost_gbp',
  'lines_seen',
  'last_seen',
  'min_confidence',
];

export function toCsvRow(m: SkuMapping, withReason: boolean): string {
  const cells = [
    m.supplier,
    m.supplierSku,
    m.aliases.join(', '),
    m.description,
    m.packSize,
    m.unitCostGbp == null ? '' : String(m.unitCostGbp),
    String(m.linesSeen),
    m.lastSeen,
    m.minConfidence.toFixed(2),
  ];
  if (withReason) cells.push(m.reason ?? '');
  return cells.map(csvCell).join(',');
}

const isCliEntry = process.argv[1]?.endsWith('extract-invoice-skus.ts') ?? false;

if (isCliEntry) {
  const src = process.argv[2] ?? join(DATA_DIR, 'bumblebee-purchase-lines.json');
  const payload = JSON.parse(readFileSync(src, 'utf8')) as {
    capture?: {
      cap_checked?: boolean;
      date_from?: string;
      date_to?: string;
      windows?: number;
      dropped_at_cap?: number;
    };
    rows: InvoiceLine[];
  };

  // See the header: the source tool truncates at 500 rows without saying so, so
  // a capture that never checked can be short by an unknown amount.
  if (!payload.capture?.cap_checked) {
    console.error(
      `${src} does not record capture.cap_checked.\n` +
        "Every window must be verified against the tool's 500-row cap before its\n" +
        'rows can be trusted. Refusing to extract from it.',
    );
    process.exit(1);
  }

  const r = extract(payload.rows);
  mkdirSync(DATA_DIR, { recursive: true });
  const write = (name: string, rows: SkuMapping[], withReason: boolean) =>
    writeFileSync(
      join(DATA_DIR, name),
      `${[
        [...CSV_HEADER, ...(withReason ? ['reason'] : [])].map(csvCell).join(','),
        ...rows.map((m) => toCsvRow(m, withReason)),
      ].join('\n')}\n`,
    );
  write('supplier-skus.csv', r.keep, false);
  write('supplier-skus-review.csv', r.review, true);

  const c = payload.capture;
  const perSupplier = new Map<string, number>();
  for (const m of r.keep) perSupplier.set(m.supplier, (perSupplier.get(m.supplier) ?? 0) + 1);
  const noCost = r.keep.filter((m) => m.unitCostGbp == null).length;
  const text = `${[
    `source             : ${src.split('/').pop()}`,
    `capture window     : ${c.date_from} .. ${c.date_to}  (${c.windows} windows, ${c.dropped_at_cap} discarded at the 500-row cap)`,
    `invoice lines      : ${r.lines}  (${r.noSku} with no SKU - nothing to map)`,
    '',
    `mappings to import : ${r.keep.length}`,
    `  aliases folded   : ${r.aliasesFolded} spelling(s) onto their canonical code`,
    `  without a cost   : ${noCost}  (imported anyway - cost_gbp is nullable; 0.00 would be a GBP0 PO line)`,
    `held for review    : ${r.review.length}  (see supplier-skus-review.csv)`,
    `  prefix conflicts : ${r.prefixConflicts}`,
    `  pack conflicts   : ${r.packConflicts}`,
    '',
    `unit_price disagreed with line_total/quantity on ${r.priceDisagreements} code(s); the`,
    'derived figure won. The observed OCR failure is a line TOTAL read into the',
    'unit-price column, which would price a purchase order several times over.',
    '',
    'Per supplier (importable):',
    ...[...perSupplier].sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${String(n).padStart(5)}  ${s}`),
    '',
    'None of these are attached to an Auto-Stock product yet - an invoice does',
    'not name one. import-invoice-skus.ts matches on the description and lists',
    'what it could not place.',
  ].join('\n')}\n`;
  writeFileSync(join(DATA_DIR, 'extract-report.txt'), text);
  process.stdout.write(text);
}
