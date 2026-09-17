/**
 * Turning a reviewed match-review sheet back into instructions.
 *
 * `propose-invoice-sku-matches.ts` writes a row per unplaced supplier code with
 * a PROPOSED product and an empty `decision` column. A human fills that column
 * in, and this reads it back. Four answers are understood:
 *
 *   Y           - accept the proposal in `proposed_stock_code`
 *   <stockcode> - no, THIS product instead (the reviewer overruled the proposal)
 *   ADD ITEM    - no product exists; create one from `new_product_name` +
 *                 `new_stock_uom`
 *   NOT STOCK   - not a stock item at all (a delivery charge, a one-off tool)
 *
 * A blank is not a fifth answer, it is an unanswered question, and it is left
 * alone rather than guessed at.
 *
 * WHY THIS PLANS BEFORE IT WRITES. Every refusal below is something that would
 * otherwise be discovered halfway through a run, with some rows already
 * committed: a stock code that does not exist, two rows asking for one product
 * under two different units, a placeholder that would become a product name.
 * `planDecisions` is pure and resolves every row against the catalogue up
 * front, so the caller can print the whole refusal list and write nothing.
 *
 * TWO ROWS MAY LEGITIMATELY NAME ONE NEW PRODUCT, and that is the point of
 * grouping by name rather than creating per row. Twist bills the same confetti
 * as `6462` and `6462-4kg`; Booker and Makro both stock Strathmore Still Glass
 * under `077549`. Those are one product with several purchasable lines -
 * exactly what `supplier_products` is for - and creating one product per row
 * would re-introduce the duplicate catalogue the September merge cleaned up.
 *
 * AN `ADD ITEM` WHOSE NAME ALREADY EXISTS IS AN ATTACH, NOT AN INSERT, for the
 * same reason. A reviewer working down a long sheet can ask for a product that
 * is already there ("Cheese (unspecified)"); honouring that literally would put
 * two identically-named products in the catalogue, and from then on half the
 * stock movements for that item would land on each. The existing product wins
 * and the run says it did.
 */

/** Stock units a new product may be created in. Deliberately short: this is
 *  the set the venues actually count in, and a typo like "kgs" silently
 *  becoming a fourth unit would split one item's stock across two spellings. */
export const ALLOWED_NEW_UOMS = ['kg', 'g', 'l', 'ml', 'each'] as const;

/** Text that betrays a cell nobody filled in. `UNKNOWN - "4 x 2.5kg" (check
 *  invoice)` reached the sheet from the client workbook's own name column via
 *  the proposal's default, and is a question, not a product. */
const PLACEHOLDER_PATTERNS = [/^unknown\b/i, /\(check\b/i, /^tbc$/i, /^\?+$/];

export function isPlaceholderName(name: string): boolean {
  const n = name.trim();
  if (n.length < 2) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(n));
}

export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export type DecisionKind = 'ACCEPT' | 'STOCK_CODE' | 'ADD' | 'SKIP' | 'UNDECIDED';

export function classifyDecision(raw: string): { kind: DecisionKind; stockCode?: string } {
  const d = raw.trim();
  if (!d) return { kind: 'UNDECIDED' };
  const u = d.toUpperCase();
  if (u === 'Y' || u === 'YES') return { kind: 'ACCEPT' };
  if (u === 'ADD ITEM' || u === 'ADD') return { kind: 'ADD' };
  if (u === 'NOT STOCK' || u === 'NOT STOCKED' || u === 'N') return { kind: 'SKIP' };
  // Anything else is read as the reviewer naming a product themselves. It is
  // validated against the catalogue below, so a typo is refused rather than
  // silently treated as "no answer".
  return { kind: 'STOCK_CODE', stockCode: d };
}

export interface DecisionRow {
  supplier: string;
  supplierSku: string;
  description: string;
  decision: string;
  proposedStockCode: string;
  newProductName: string;
  newStockUom: string;
  linesSeen: number;
}

export interface CatalogueProduct {
  id: string;
  name: string;
  stockCode: string | null;
}

/** A product this run must create, and the rows that asked for it. */
export interface NewProductPlan {
  name: string;
  stockUom: string;
  stockCode: string;
  slug: string;
  askedBy: Array<{ supplier: string; supplierSku: string }>;
}

export interface ResolvedRow {
  supplier: string;
  supplierSku: string;
  description: string;
  linesSeen: number;
  /** Set when the row resolved to a product that already exists. */
  productId?: string;
  /** Set when the row resolved to a product this run will create. */
  newProductKey?: string;
  via: 'ACCEPT' | 'STOCK_CODE' | 'ADD_EXISTING' | 'ADD_NEW';
}

export interface Refusal {
  supplier: string;
  supplierSku: string;
  description: string;
  reason: string;
}

export interface DecisionPlan {
  resolved: ResolvedRow[];
  newProducts: NewProductPlan[];
  /** `ADD ITEM` rows whose name already existed. Attached, not created. */
  adoptedExisting: Array<{ supplier: string; supplierSku: string; name: string; stockCode: string | null }>;
  skipped: Array<{ supplier: string; supplierSku: string; description: string }>;
  undecided: Array<{ supplier: string; supplierSku: string; description: string }>;
  refusals: Refusal[];
}

/**
 * Build a stock code in the catalogue's own shape: up to three four-character
 * segments, uppercase, hyphenated (`BAKE-COCO-POWD`). The catalogue's first
 * segment is a category a human chose and this cannot know one, so it takes
 * the name's own leading words instead - a code that reads as the product
 * rather than one that claims a category it was never given.
 *
 * `taken` is both the live catalogue and the codes minted earlier in the same
 * run; a clash gets `-2`, `-3`, matching the `KOPP-2` / `ORAN-2` pairs already
 * in the catalogue.
 */
const CODE_STOPWORDS = new Set([
  'the', 'and', 'of', 'a', 'an', 'with', 'for', 'in', 'on', 'to', 'size', 'x',
]);

export function stockCodeFor(name: string, taken: Set<string>): string {
  const words = normaliseName(name)
    .split(' ')
    .filter((w) => w && !CODE_STOPWORDS.has(w));
  const segs = words.slice(0, 3).map((w) => w.slice(0, 4).toUpperCase());
  let base = segs.join('-');
  // A name that is entirely stopwords or punctuation leaves nothing to build
  // from. Refuse rather than mint an empty code that would collide with every
  // other empty one.
  if (!base) base = 'ITEM';
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * @param reserved Codes that must not be minted even though no LIVE product
 *   holds them. `products_company_id_slug_unq` is unique on `(company, slug)`
 *   and takes no notice of `deleted_at`, so a slug freed by the September
 *   duplicate merge is still occupied as far as Postgres is concerned - and a
 *   new product's slug is its stock code lowercased. The caller passes every
 *   slug in the table, soft-deleted included, uppercased.
 */
export function planDecisions(
  rows: DecisionRow[],
  catalogue: CatalogueProduct[],
  reserved: Iterable<string> = [],
): DecisionPlan {
  const byStockCode = new Map<string, CatalogueProduct>();
  // A name shared by two live products identifies neither, so it identifies
  // NEITHER - the same poisoning rule the code-first importer uses. An
  // `ADD ITEM` landing on an ambiguous name is refused, not resolved to
  // whichever row came back first.
  const byName = new Map<string, CatalogueProduct | null>();
  const takenCodes = new Set<string>();
  for (const r of reserved) takenCodes.add(r.trim().toUpperCase());
  for (const p of catalogue) {
    if (p.stockCode) {
      byStockCode.set(p.stockCode.trim().toUpperCase(), p);
      takenCodes.add(p.stockCode.trim().toUpperCase());
    }
    const n = normaliseName(p.name);
    if (!n) continue;
    byName.set(n, byName.has(n) ? null : p);
  }

  const plan: DecisionPlan = {
    resolved: [], newProducts: [], adoptedExisting: [], skipped: [], undecided: [], refusals: [],
  };
  const newByKey = new Map<string, NewProductPlan>();
  // Collected before any code is minted, so the codes come out in the file's
  // own order rather than depending on which name was refused.
  const pendingNew: Array<{ key: string; row: DecisionRow }> = [];

  for (const row of rows) {
    const where = { supplier: row.supplier, supplierSku: row.supplierSku, description: row.description };
    const { kind, stockCode } = classifyDecision(row.decision);

    if (kind === 'UNDECIDED') { plan.undecided.push(where); continue; }
    if (kind === 'SKIP') { plan.skipped.push(where); continue; }

    if (kind === 'ACCEPT' || kind === 'STOCK_CODE') {
      const wanted = (kind === 'ACCEPT' ? row.proposedStockCode : stockCode ?? '').trim().toUpperCase();
      if (!wanted) {
        plan.refusals.push({ ...where, reason: 'decision is "Y" but the row has no proposed stock code' });
        continue;
      }
      const product = byStockCode.get(wanted);
      if (!product) {
        plan.refusals.push({
          ...where,
          reason: `no live product has stock code "${wanted}"`,
        });
        continue;
      }
      plan.resolved.push({
        ...where, linesSeen: row.linesSeen, productId: product.id,
        via: kind === 'ACCEPT' ? 'ACCEPT' : 'STOCK_CODE',
      });
      continue;
    }

    // kind === 'ADD'
    const name = row.newProductName.trim();
    const uom = row.newStockUom.trim().toLowerCase();
    if (!name) {
      plan.refusals.push({ ...where, reason: 'decision is "ADD ITEM" but new_product_name is empty' });
      continue;
    }
    if (isPlaceholderName(name)) {
      plan.refusals.push({
        ...where,
        reason: `new_product_name is a placeholder, not a product name: "${name}"`,
      });
      continue;
    }
    if (!(ALLOWED_NEW_UOMS as readonly string[]).includes(uom)) {
      plan.refusals.push({
        ...where,
        reason: `new_stock_uom "${row.newStockUom}" is not one of ${ALLOWED_NEW_UOMS.join(', ')}`,
      });
      continue;
    }

    const key = normaliseName(name);
    const existing = byName.get(key);
    if (existing === null) {
      plan.refusals.push({
        ...where,
        reason: `"${name}" is the name of more than one live product - say which with a stock code`,
      });
      continue;
    }
    if (existing) {
      plan.adoptedExisting.push({
        supplier: row.supplier, supplierSku: row.supplierSku,
        name: existing.name, stockCode: existing.stockCode,
      });
      plan.resolved.push({ ...where, linesSeen: row.linesSeen, productId: existing.id, via: 'ADD_EXISTING' });
      continue;
    }

    const already = newByKey.get(key);
    if (already) {
      if (already.stockUom !== uom) {
        plan.refusals.push({
          ...where,
          reason: `"${name}" is also being added as "${already.stockUom}" - one product cannot hold two units`,
        });
        continue;
      }
      already.askedBy.push({ supplier: row.supplier, supplierSku: row.supplierSku });
    } else {
      newByKey.set(key, {
        name, stockUom: uom, stockCode: '', slug: '',
        askedBy: [{ supplier: row.supplier, supplierSku: row.supplierSku }],
      });
      pendingNew.push({ key, row });
    }
    plan.resolved.push({ ...where, linesSeen: row.linesSeen, newProductKey: key, via: 'ADD_NEW' });
  }

  for (const { key } of pendingNew) {
    const np = newByKey.get(key)!;
    np.stockCode = stockCodeFor(np.name, takenCodes);
    np.slug = np.stockCode.toLowerCase();
    plan.newProducts.push(np);
  }

  return plan;
}
