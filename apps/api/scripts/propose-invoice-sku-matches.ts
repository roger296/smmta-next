/**
 * Propose which product each unmatched supplier code belongs to, for a human
 * to confirm.
 *
 *   npx tsx apps/api/scripts/propose-invoice-sku-matches.ts --catalogue=products.csv
 *   npx tsx apps/api/scripts/propose-invoice-sku-matches.ts          # reads the DB
 *
 * WRITES NOTHING TO THE DATABASE. It produces a review file, and
 * `import-invoice-skus.ts --decisions` applies whatever comes back decided.
 *
 * `import-invoice-skus.ts` on its own matches only on stock code or an exact
 * name, and against the live catalogue that placed 29 of 461 codes. The rest
 * fail because a supplier describes goods its own way — "Wholesome Farms
 * Unsalted Butter" against a catalogue that says "Unsalted Butter" — and no
 * amount of cleverness makes that a decision a script should take alone. So it
 * ranks candidates and hands the file over.
 *
 * ── Every row needs a decision, including the ones with no candidate ──────
 * The point is not "the ones I could guess". A supplier code with no plausible
 * product is either something the catalogue is MISSING or something that was
 * never stock, and both are answers somebody has to give — otherwise the item
 * stays unorderable and nobody ever finds out why. The four legal decisions:
 *
 *     y             the proposal is right
 *     <stock code>  wrong - it is this one instead
 *     ADD ITEM      no product exists; create one
 *     NOT STOCK     not a stock item at all
 *
 * `ADD ITEM` is spelled as `extract-count-list.ts` already spells it, so the
 * catalogue tooling has one convention rather than two.
 *
 * ⚠️ NOT EVERYTHING SHOULD BECOME A PRODUCT. The unmatched pile contains a
 * pressure washer, hair bobbles and a laminating pouch — one-off Amazon buys,
 * not things a venue counts. Defaulting those to ADD ITEM would fill the
 * catalogue with pressure washers, so nothing is defaulted: the decision
 * column ships EMPTY and the file is not importable until it is filled in.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as csvParse } from 'csv-parse/sync';
import { csvCell } from '../src/shared/utils/csv.js';
import { proposeMatch, type CatalogueProduct } from '../src/modules/suppliers/invoice-sku-match.js';
import {
  descriptionTokens, nameByCode, nameByDescription, normaliseCode, validate,
  type ClientKeyItem, type ValidatedItem,
} from '../src/modules/suppliers/client-key-items.js';

const DATA_DIR = join(import.meta.dirname, '..', 'data', 'invoice-skus');

export interface ReviewRow {
  supplier: string;
  supplierSku: string;
  description: string;
  packSize: string;
  baseUnit: string;
  unitCostGbp: string;
  linesSeen: number;
  proposedProduct: string;
  proposedStockCode: string;
  /** Second and third choices, so a wrong first guess is one glance to fix. */
  alternatives: string;
  /** Empty by design — see the header. */
  decision: string;
  /** Pre-filled suggestions used only when the decision is ADD ITEM. */
  newProductName: string;
  newStockUom: string;
  /**
   * Where the proposal came from, so the reviewer knows how hard to look:
   * `client-sku` and `client-description` are Rebecca's own answer, `matched`
   * is this script's string matching, `none` is nothing to go on.
   */
  source: 'client-sku' | 'client-description' | 'matched' | 'none';
  /** The client's name for it, even when no product carries that name yet —
   *  which is the ADD ITEM case with the name already chosen. */
  clientName: string;
}

export const REVIEW_HEADER = [
  'supplier', 'supplier_sku', 'description', 'pack_size', 'lines_seen', 'unit_cost_gbp',
  'client_name', 'source', 'proposed_product', 'proposed_stock_code', 'alternatives',
  'decision', 'new_product_name', 'new_stock_uom',
];

/**
 * BumbleBee's base unit is what the invoice weighed in. A venue counts
 * CONTAINERS — bottles, sacks, boxes — so `each` is the safer opening
 * suggestion for anything that is not obviously bulk. Same reasoning as
 * extract-count-list.ts, which learned it the hard way: a wrong unit silently
 * corrupts every future count, and `each` is at least what a counter does.
 */
export function suggestStockUom(baseUnit: string): string {
  const b = baseUnit.trim().toLowerCase();
  if (b === 'kg' || b === 'l') return b;
  return 'each';
}

/** Find the client's name for an invoice description, by token containment. */
function clientNameForDescription(
  description: string,
  byDescription: Array<{ tokens: Set<string>; name: string }>,
): string {
  const d = descriptionTokens(description);
  if (d.size === 0) return '';
  let best = '';
  let bestShared = 0;
  for (const c of byDescription) {
    let shared = 0;
    for (const t of c.tokens) if (d.has(t)) shared += 1;
    // Most of the client's words have to appear, or it is not that row.
    if (shared / c.tokens.size >= 0.6 && shared > bestShared) {
      bestShared = shared;
      best = c.name;
    }
  }
  return best;
}

export function buildReview(
  skus: Array<Record<string, string>>,
  catalogue: CatalogueProduct[],
  alreadyMapped: Set<string>,
  clientItems: ValidatedItem[] = [],
): ReviewRow[] {
  const byCode = nameByCode(clientItems);
  const byDescription = nameByDescription(clientItems);
  const productByName = new Map(catalogue.map((p) => [p.name.trim().toLowerCase(), p]));
  const rows: ReviewRow[] = [];
  for (const s of skus) {
    const supplier = (s.supplier ?? '').trim();
    const sku = (s.supplier_sku ?? '').trim();
    if (!supplier || !sku) continue;
    if (alreadyMapped.has(`${supplier.toLowerCase()}::${sku.toLowerCase()}`)) continue;

    const description = (s.description ?? '').trim();
    const p = proposeMatch(description, sku, catalogue);
    // A certain match needs no review — import-invoice-skus.ts already takes
    // those on its own.
    if (p.certain) continue;

    /**
     * The client's own answer beats string matching, so it is tried first —
     * by SKU where the invoices corroborate the row, then by description,
     * which is the axis the misaligned rows still support.
     */
    const clientName =
      byCode.get(normaliseCode(sku)) ?? clientNameForDescription(description, byDescription);
    const clientProduct = clientName ? productByName.get(clientName.trim().toLowerCase()) : undefined;
    const best = p.candidates[0];

    const source: ReviewRow['source'] = clientProduct
      ? byCode.has(normaliseCode(sku))
        ? 'client-sku'
        : 'client-description'
      : best
        ? 'matched'
        : 'none';

    const baseUnit = (s.base_unit ?? '').trim();
    rows.push({
      supplier,
      supplierSku: sku,
      description,
      packSize: (s.pack_size ?? '').trim(),
      baseUnit,
      unitCostGbp: (s.unit_cost_gbp ?? '').trim(),
      linesSeen: Number(s.lines_seen) || 0,
      clientName,
      source,
      proposedProduct: clientProduct?.name ?? best?.product.name ?? '',
      proposedStockCode: clientProduct?.stockCode ?? best?.product.stockCode ?? '',
      alternatives: p.candidates
        .slice(1)
        .map((c) => `${c.product.name} [${c.product.stockCode ?? '-'}]`)
        .join(' | '),
      decision: '',
      // The client already chose a name where they named one; that is a far
      // better starting point for a new product than the supplier's own wording.
      newProductName: clientName || description,
      newStockUom: suggestStockUom(baseUnit),
    });
  }
  // Busiest first: this is a work list, and the code on 158 invoice lines is
  // worth a human's attention before the one seen twice.
  rows.sort((a, b) => b.linesSeen - a.linesSeen || a.supplier.localeCompare(b.supplier));
  return rows;
}

export function toReviewCsv(rows: ReviewRow[]): string {
  const body = rows.map((r) =>
    [
      r.supplier, r.supplierSku, r.description, r.packSize, String(r.linesSeen), r.unitCostGbp,
      r.clientName, r.source, r.proposedProduct, r.proposedStockCode, r.alternatives,
      r.decision, r.newProductName, r.newStockUom,
    ].map(csvCell).join(','),
  );
  return `${[REVIEW_HEADER.map(csvCell).join(','), ...body].join('\n')}\n`;
}

/** Read a products export (the Products page Export button) as a catalogue. */
export function catalogueFromExport(text: string): CatalogueProduct[] {
  const rows = csvParse(text, { columns: true, skip_empty_lines: true, bom: true }) as Array<
    Record<string, string>
  >;
  return rows
    .map((r) => ({
      id: r['Product ID'] ?? '',
      stockCode: r['Stock code'] || null,
      name: (r.Name ?? '').trim(),
    }))
    .filter((p) => p.name);
}

const isCliEntry = process.argv[1]?.endsWith('propose-invoice-sku-matches.ts') ?? false;

if (isCliEntry) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
  const cataloguePath = arg('catalogue');
  if (!cataloguePath) {
    console.error(
      'Give it a catalogue: --catalogue=<the Products page Export csv>.\n' +
        'Exporting from the UI keeps this runnable anywhere, which is how the\n' +
        'proposal can be tuned and reviewed before it goes near the database.',
    );
    process.exit(1);
  }
  const catalogue = catalogueFromExport(readFileSync(cataloguePath, 'utf8'));
  const skus = csvParse(readFileSync(join(DATA_DIR, 'supplier-skus.csv'), 'utf8'), {
    columns: true, skip_empty_lines: true, bom: true,
  }) as Array<Record<string, string>>;

  // The client's workbook, if it has been converted. Its SKU column is
  // validated against the invoice lines before any of it is keyed on — see
  // modules/suppliers/client-key-items.ts.
  let clientItems: ValidatedItem[] = [];
  const clientPath = join(DATA_DIR, 'client-key-items.csv');
  if (existsSync(clientPath)) {
    const raw = csvParse(readFileSync(clientPath, 'utf8'), {
      columns: true, skip_empty_lines: true, bom: true,
    }) as Array<Record<string, string>>;
    const items: ClientKeyItem[] = raw.map((r) => ({
      suggestedName: (r.suggested_name ?? '').trim(),
      stockItem: (r.stock_item ?? '').trim(),
      category: (r.category ?? '').trim(),
      groupId: (r.group_id ?? '').trim(),
      sku: (r.sku ?? '').trim(),
      supplier: (r.supplier ?? '').trim(),
      packSize: (r.pack_size ?? '').trim(),
      sheet: (r.sheet ?? '').trim(),
    }));
    const invoiceByCode = new Map<string, string>();
    for (const m of skus) {
      const desc = (m.description ?? '').trim();
      for (const code of [m.supplier_sku, ...(m.aliases ?? '').split(',')]) {
        const c = normaliseCode((code ?? '').trim());
        if (c && desc) invoiceByCode.set(c, desc);
      }
    }
    clientItems = validate(items, invoiceByCode);
    const mism = clientItems.filter((i) => i.trust === 'sku-mismatched').length;
    console.log(`[propose-invoice-sku-matches] client sheet: ${clientItems.length} rows`);
    console.log(`  corroborated by the invoices : ${clientItems.filter((i) => i.trust === 'sku-and-description').length}`);
    console.log(`  SKU contradicted, name kept  : ${mism}`);
    console.log(`  no invoice line for the code : ${clientItems.filter((i) => i.trust === 'description-only').length}\n`);
  }

  const rows = buildReview(skus, catalogue, new Set(), clientItems);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'match-review.csv'), toReviewCsv(rows));

  const withProposal = rows.filter((r) => r.proposedStockCode).length;
  const bySource = (src: ReviewRow['source']) => rows.filter((r) => r.source === src).length;
  console.log(`[propose-invoice-sku-matches] catalogue : ${catalogue.length} products`);
  console.log(`  codes needing a decision : ${rows.length}`);
  console.log(`    with a proposal        : ${withProposal}  (tick y, or type the right stock code)`);
  console.log(`      from the client s SKU      : ${bySource('client-sku')}`);
  console.log(`      from the client s wording  : ${bySource('client-description')}`);
  console.log(`      from string matching       : ${bySource('matched')}`);
  console.log(`    with none              : ${rows.length - withProposal}  (ADD ITEM or NOT STOCK)`);
  const named = rows.filter((r) => !r.proposedStockCode && r.clientName).length;
  console.log(`      of which the client HAS named: ${named}  (ADD ITEM, name already chosen)`);
  console.log(`\n  written: ${join(DATA_DIR, 'match-review.csv')}`);
  console.log('  Every row needs a decision. The column ships empty on purpose -');
  console.log('  a pressure washer defaulting to ADD ITEM is how a catalogue fills');
  console.log('  up with pressure washers.');
}
