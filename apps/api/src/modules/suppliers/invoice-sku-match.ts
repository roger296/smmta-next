/**
 * Proposing which Auto-Stock product a supplier's invoice line refers to.
 *
 * This is the hard half of the invoice import, and the half that must never
 * decide on its own. A supplier describes goods its own way ("Wholesome Farms
 * Unsalted Butter", "Noble Free Range Liquid Egg White") and the venue counts
 * them another ("Unsalted Butter", "Egg Whites"). Only an operator knows which
 * pairs are the same thing.
 *
 * So nothing here writes anything. It ranks candidates and hands them to a
 * human as a review file. `import-invoice-skus.ts` applies only what comes back
 * decided.
 *
 * ── The false positives that shaped these rules ───────────────────────────
 * A first cut matched a catalogue name whose words all appear in the supplier
 * description. Against the real catalogue that produced, among 177 "matches":
 *
 *     Vytronix Powerful Electric Pressure Washer 1400W  ->  Yellow
 *     8Pcs Fondant Tools, Cake Decorating & Modelling   ->  Icing Sugar
 *     The Chic Way 40 Pcs Hair Bobbles, Elastic Ha      ->  Black
 *     Jantex Commercial Washing Up Liquid Concentrate   ->  Green
 *
 * The catalogue carries colouring products literally named "Yellow", "Black",
 * "White" and "Green", so any description mentioning a colour matched one. The
 * fix is NOT a stopword list of colours — the next catalogue has a different
 * set of short names. It is COVERAGE: a candidate has to account for a decent
 * share of what the supplier actually wrote. "Yellow" explains one word of a
 * fifteen-word pressure washer; "Cornflour" explains the whole of "Sysco
 * Classic Cornflour" once the brand words are set aside.
 */

/** Words that carry no identifying weight in either name. */
const NOISE = new Set([
  // grammar
  'the', 'and', 'of', 'a', 'an', 'with', 'for', 'in', 'to',
  // supplier house brands — they identify the seller, not the goods
  'brake', 'brakes', 'sysco', 'classic', 'classc', 'essentials', 'premium',
  'cl', 'ci', 'professional', 'pro', 'bb', 'sb',
  // pack furniture
  'x', 'pack', 'pk', 'case', 'ea', 'each', 'ltr', 'ltrs', 'litre', 'litres',
  'kg', 'kgs', 'g', 'gm', 'gms', 'ml', 'cl', 'approx', 'aprox', 'av', 'ptn',
  'ptns', 'sizes', 'size', 'available', 'regular', 'product', 'id',
]);

export interface CatalogueProduct {
  id: string;
  stockCode: string | null;
  name: string;
}

export interface MatchCandidate {
  product: CatalogueProduct;
  /** 0..1 — share of the supplier's own words this candidate accounts for. */
  coverage: number;
  /** How many significant words the candidate name contributed. */
  matched: number;
}

export interface MatchProposal {
  /** Exact name or stock code — safe to apply without review. */
  certain: CatalogueProduct | null;
  /** Ranked, best first. Empty when nothing plausible exists. */
  candidates: MatchCandidate[];
}

/** Lower-cased, punctuation collapsed to single spaces. */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Crude singularisation, so a catalogue's "Egg Whites" meets an invoice's
 * "Liquid Egg White" — 123 invoice lines hung on that one trailing `s`.
 *
 * It does not have to be linguistically right, only CONSISTENT: both sides go
 * through it, so "Molasses" landing on `molass` costs nothing as long as every
 * spelling of molasses lands there too. What does cost something is two forms
 * of one word landing apart, which is why `-oes` is handled (tomatoes/tomato)
 * and why the `-es` rule is otherwise confined to where English actually adds
 * it, after s, x, z, ch, sh.
 *
 * Deliberately not a real stemmer: matching "butter" to "buttery" would be a
 * wrong proposal, and a missed one only costs a lookup.
 */
function singular(t: string): string {
  if (t.length <= 3 || !t.endsWith('s') || t.endsWith('ss')) return t;
  // `-es` only drops whole where English actually adds it: after s, x, z, ch,
  // sh (boxes, dishes). Everywhere else it is a plain `-s`, and treating
  // "whites" as "whit" instead of "white" was exactly the miss this is for.
  const stem = t.slice(0, -2);
  if (t.endsWith('es') && /(?:s|x|z|ch|sh|o)$/.test(stem)) return stem;
  return t.slice(0, -1);
}

/** The words that actually identify goods: no grammar, brands or pack furniture,
 *  and no bare numbers (a `1400w` or a `40` says nothing about what a thing is). */
export function significantTokens(text: string): Set<string> {
  return new Set(
    normaliseName(text)
      .split(' ')
      .filter((t) => t.length > 1 && !NOISE.has(t) && !/^\d+[a-z]*$/.test(t))
      .map(singular),
  );
}

/**
 * How much of the supplier's description a catalogue name accounts for.
 *
 * Deliberately measured against the DESCRIPTION, not the candidate: every
 * candidate matches 100% of itself, which is why the first cut let "Yellow"
 * through. Returns 0 when the candidate does not fit entirely — a partial
 * overlap ("Unsalted Butter" vs "Salted Butter") is not a weaker match, it is
 * a different product.
 */
export function coverage(candidateName: string, description: string): number {
  const cand = significantTokens(candidateName);
  const desc = significantTokens(description);
  if (cand.size === 0 || desc.size === 0) return 0;
  for (const t of cand) if (!desc.has(t)) return 0;
  return cand.size / desc.size;
}

/**
 * Below this a candidate explains too little of what the supplier wrote to be
 * worth an operator's attention.
 *
 * 0.3 keeps "Cornflour" against "Sysco Classic Cornflour" (one significant word
 * of one, brand words dropped) and "Egg Whites" against "Noble Free Range
 * Liquid Egg White" (two of six), while still dropping "Yellow" against a
 * fifteen-word pressure washer (one of ten). Tuned against the real 561-product
 * catalogue and the real invoice descriptions, not picked.
 *
 * Erring low costs a wrong proposal, which an operator has to notice and
 * correct. Erring high costs a missing one, which is a lookup. The second is
 * cheaper, so this sits nearer the cautious end than the recall-maximising one.
 */
export const MIN_COVERAGE = 0.3;

/**
 * Colour words, and the one rule that uses them.
 *
 * The catalogue carries colouring products literally named "White", "Yellow",
 * "Black", "Green" and "Brown". A colour is almost always a MODIFIER in a
 * supplier's description — "Grapes White Seedless", "SUGAR PASTE-M&B-WHITE",
 * "Large Blue Vinyl Gloves" — so a candidate that is NOTHING BUT a colour
 * matches the modifier and means nothing. At the tuned coverage those started
 * getting through again: "White" explains one word of three in "Grapes White
 * Seedless", which clears 0.3.
 *
 * So the test is on the CANDIDATE, not the description, and only when the
 * candidate is entirely colours: "White" is rejected, "White Grapes" and
 * "Blue Vinyl Gloves - Large" are not. Deliberately narrow — a general
 * stopword list of short names would take "Basil", "Cheese" and "Cornflour"
 * with it, and those are the proposals worth having.
 */
const COLOURS = new Set([
  'white', 'black', 'red', 'green', 'blue', 'yellow', 'brown', 'pink',
  'purple', 'gold', 'silver',
]);
// ⚠️ `orange` is NOT in there. In a food catalogue it is a fruit long before it
// is a colour, and excluding it cost the proposal for "Brakes The Juice Orange"
// -> "Orange Juice". The list is colours that are ONLY colours here; a
// different catalogue might have to think again about `brown`.

function isNothingButColour(tokens: Set<string>): boolean {
  if (tokens.size === 0) return false;
  for (const t of tokens) if (!COLOURS.has(t)) return false;
  return true;
}

export function proposeMatch(
  description: string,
  supplierSku: string,
  catalogue: CatalogueProduct[],
): MatchProposal {
  const wanted = normaliseName(description);
  const bySku = supplierSku.trim().toLowerCase();

  for (const p of catalogue) {
    if (p.stockCode && p.stockCode.trim().toLowerCase() === bySku) {
      return { certain: p, candidates: [] };
    }
  }
  const exact = catalogue.filter((p) => normaliseName(p.name) === wanted);
  // Two live products under one name identify NEITHER — that is a review case,
  // not a match.
  if (exact.length === 1) return { certain: exact[0]!, candidates: [] };

  const candidates: MatchCandidate[] = [];
  for (const p of catalogue) {
    if (isNothingButColour(significantTokens(p.name))) continue;
    const c = coverage(p.name, description);
    if (c >= MIN_COVERAGE) {
      candidates.push({ product: p, coverage: c, matched: significantTokens(p.name).size });
    }
  }
  // Best coverage first; on a tie the more specific name wins, so "Orange
  // Juice" is offered above "Orange".
  candidates.sort(
    (a, b) => b.coverage - a.coverage || b.matched - a.matched || a.product.name.localeCompare(b.product.name),
  );
  return { certain: null, candidates: candidates.slice(0, 3) };
}

/**
 * What an operator may write in the review file's decision column.
 *
 * `ADD ITEM` is spelled the same as in extract-count-list.ts, which already
 * uses it for exactly this — one convention across the catalogue tooling, not
 * two.
 */
export type Decision =
  | { kind: 'CONFIRM' }
  | { kind: 'PRODUCT'; stockCodeOrName: string }
  | { kind: 'ADD_ITEM' }
  | { kind: 'NOT_STOCK' }
  | { kind: 'UNDECIDED' };

export function parseDecision(cell: string | null | undefined): Decision {
  const v = (cell ?? '').trim();
  if (!v) return { kind: 'UNDECIDED' };
  const u = v.toUpperCase();
  if (u === 'Y' || u === 'YES') return { kind: 'CONFIRM' };
  if (u === 'ADD ITEM' || u === 'ADD') return { kind: 'ADD_ITEM' };
  if (u === 'NOT STOCK' || u === 'N' || u === 'NO' || u === 'SKIP') return { kind: 'NOT_STOCK' };
  return { kind: 'PRODUCT', stockCodeOrName: v };
}
