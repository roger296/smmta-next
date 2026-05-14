/**
 * Rule-based category assignment.
 *
 * `RULES` is an ordered list. The backfill script walks each product,
 * applies rules top-to-bottom, and the first match wins. Anything that
 * doesn't match falls through to `Uncategorised`.
 *
 * Design principles for the rule order:
 *
 *   1. **Context wins over garment type.** A hi-vis polo lives in
 *      Workwear → Hi-vis tops, not Tops → Polo shirts. Wear context
 *      is more useful to the customer than the literal garment.
 *
 *   2. **Age wins over context for kids.** A kid's hoodie lives in
 *      Kids & Schoolwear → Kids' tops, not Tops → Hoodies. Kids and
 *      adults shop on different pages.
 *
 *   3. **Garment-type fallthrough at the bottom.** Once context and
 *      age are exhausted, the regex on `productType` does the bulk
 *      of the work for ordinary apparel.
 *
 *   4. **Last rule must be a catch-all? No.** We deliberately don't
 *      add a last-resort rule — anything unmatched lands in
 *      `Uncategorised`, which is the signal to add more rules. The
 *      backfill's end-of-run summary tells the operator how big that
 *      bucket is.
 *
 * `assignTo` is a slug path like `workwear-and-safety/hi-vis-tops-and-vests`
 * matching the taxonomy in `taxonomy.ts`. The evaluator validates
 * each rule's slug path against the taxonomy on startup; a typo
 * fails-fast rather than silently dumping products into nowhere.
 */
import { TAXONOMY, findTaxonomyEntry } from './taxonomy.js';

/** Fields the rule engine matches against. Sourced from the product
 *  row + the upstream supplier data we captured at import time. */
export interface ProductFacts {
  /** `'ralawise'` | `'uneek'` — comes from `supplier_products → suppliers.slug`. */
  source: string;
  /** Ralawise `Product Type` column (col 28) or the closest Uneek
   *  equivalent. Free-text, supplier-curated. */
  productType?: string | null;
  /** Ralawise `Categorisation` column (col 35) — pipe-separated
   *  taxonomy paths from their own system. Long and noisy, but
   *  carries the wear-context signal we need for hi-vis etc. */
  categorisation?: string | null;
  /** `'Male' | 'Female' | 'Unisex' | 'Kids' | ...` — Ralawise col 29
   *  or whatever the Uneek equivalent ends up being. */
  gender?: string | null;
  /** `'Adult' | 'Child' | 'Baby'` — Ralawise col 30. */
  ageGroup?: string | null;
  /** Product name — fallback when nothing else fires (e.g. "rugby
   *  shirt" → tops/shirts). */
  name?: string | null;
}

export interface MappingRule {
  /** Optional source filter — when set, the rule only fires for the
   *  named supplier. Most rules apply to both. */
  source?: 'ralawise' | 'uneek';
  productType?: RegExp;
  /** Case-insensitive substring against the Ralawise `Categorisation`
   *  pipe-separated string. Multiple tokens with `|` are OR-ed. */
  categorisationContains?: string;
  /** Case-insensitive substring against the product name — last-resort
   *  matching for products with no structured type. */
  nameContains?: RegExp;
  /** Exact-match (case-insensitive). */
  ageGroupEquals?: 'Adult' | 'Child' | 'Baby' | 'Teen';
  /** Optional human-readable note explaining the rule. */
  rationale?: string;
  /** Slug path. Validated against the taxonomy at module load. */
  assignTo: string;
}

// ============================================================
// Rule set
// ============================================================

export const RULES: MappingRule[] = [
  // ───────────────────────────────────────────────────────────
  // 1. Hi-vis / safety context wins over garment type.
  //    Hi-vis signals can come from the supplier's categorisation
  //    column OR straight from the product name. We check both
  //    because the importer stored only the FIRST segment of
  //    Ralawise's pipe-separated Categorisation.
  // ───────────────────────────────────────────────────────────
  {
    nameContains: /hi.?vis.*(jacket|coat|bomber|softshell|parka)/i,
    assignTo: 'workwear-and-safety/hi-vis-outerwear',
    rationale: 'Hi-vis outer layers detected by name (Hi-Vis Jacket etc)',
  },
  {
    categorisationContains: 'Hi-Vis Jacket|Hi-Vis Coat|Hi Vis Jacket',
    assignTo: 'workwear-and-safety/hi-vis-outerwear',
  },
  {
    nameContains: /\b(hi.?vis|high.?visibility)\b/i,
    assignTo: 'workwear-and-safety/hi-vis-tops-and-vests',
    rationale: 'Hi-vis tops + vests detected by name',
  },
  {
    categorisationContains: 'Hi-Vis|Hi Vis|HiVis|High Visibility',
    assignTo: 'workwear-and-safety/hi-vis-tops-and-vests',
    rationale: 'Hi-vis fallback via categorisation column',
  },
  {
    categorisationContains: 'Coverall|Overall|Boilersuit',
    assignTo: 'workwear-and-safety/overalls-and-coveralls',
    rationale: 'Coveralls / boilersuits',
  },
  {
    categorisationContains: 'Work Trouser|Workwear Trouser|Cargo Trouser|Combat Trouser',
    assignTo: 'workwear-and-safety/work-trousers',
    rationale: 'Workwear-context trousers',
  },
  {
    categorisationContains: 'Apron|Tabard',
    productType: /apron|tabard/i,
    assignTo: 'workwear-and-safety/aprons-and-tabards',
    rationale: 'Aprons + tabards (often hospitality-driven)',
  },
  {
    categorisationContains: 'Apron|Tabard',
    assignTo: 'workwear-and-safety/aprons-and-tabards',
  },
  {
    productType: /apron|tabard/i,
    assignTo: 'workwear-and-safety/aprons-and-tabards',
  },

  // ───────────────────────────────────────────────────────────
  // 2. Kids & Schoolwear — age wins over garment type.
  //    ageGroup data isn't always available (the importer doesn't
  //    capture it for every row), so we also detect by name patterns
  //    (Kids/Junior/Children/Schoolwear/Toddler/Baby).
  // ───────────────────────────────────────────────────────────
  {
    nameContains: /\b(baby|toddler|infant|newborn)\b/i,
    assignTo: 'kids-and-schoolwear/baby-and-toddler',
    rationale: 'Baby / toddler — by name',
  },
  {
    ageGroupEquals: 'Baby',
    assignTo: 'kids-and-schoolwear/baby-and-toddler',
  },
  {
    nameContains: /\b(kids|kid'?s|childrens?|child'?s|junior|school)\b.*\b(rugby|football|cricket|sports?|pe kit)\b/i,
    assignTo: 'kids-and-schoolwear/school-sports-kit',
    rationale: 'School sports kit — by name',
  },
  {
    nameContains: /\b(kids|kid'?s|childrens?|child'?s|junior)\b.*\b(jacket|coat|fleece|bodywarmer|gilet|softshell|waterproof|anorak|parka)\b/i,
    assignTo: 'kids-and-schoolwear/kids-outerwear',
    rationale: "Kids' outerwear — by name",
  },
  {
    nameContains: /\b(kids|kid'?s|childrens?|child'?s|junior)\b.*\b(trouser|short|jogger|legging|skirt|pant)\b/i,
    assignTo: 'kids-and-schoolwear/kids-bottoms',
    rationale: "Kids' bottoms — by name",
  },
  {
    nameContains: /\b(kids|kid'?s|childrens?|child'?s|junior|school|cardigan)\b/i,
    assignTo: 'kids-and-schoolwear/kids-tops',
    rationale: "Kids' tops + general kids' wear — by name",
  },
  {
    ageGroupEquals: 'Child',
    categorisationContains: 'Sport|Sports|PE|Rugby|Football|Cricket|Tennis',
    assignTo: 'kids-and-schoolwear/school-sports-kit',
    rationale: "Kids' sportswear → school sports kit",
  },
  {
    ageGroupEquals: 'Child',
    productType: /T-Shirt|Polo|Hoodie|Sweatshirt|Shirt|Tank|Vest|Jumper/i,
    assignTo: 'kids-and-schoolwear/kids-tops',
    rationale: "Kids' upper-body wear",
  },
  {
    ageGroupEquals: 'Child',
    productType: /Trouser|Short|Jogger|Legging|Skirt|Pant/i,
    assignTo: 'kids-and-schoolwear/kids-bottoms',
    rationale: "Kids' lower-body wear",
  },
  {
    ageGroupEquals: 'Child',
    productType: /Jacket|Coat|Fleece|Hoodie|Bodywarmer|Gilet|Softshell|Waterproof|Anorak/i,
    assignTo: 'kids-and-schoolwear/kids-outerwear',
    rationale: "Kids' outer layers",
  },
  {
    ageGroupEquals: 'Child',
    assignTo: 'kids-and-schoolwear/kids-tops',
    rationale: "Catch-all for remaining kids' apparel → tops",
  },

  // ───────────────────────────────────────────────────────────
  // 3. Sport & Active.
  // ───────────────────────────────────────────────────────────
  {
    categorisationContains: 'Performance|Cooltex|Wicking|Quick Dry',
    productType: /T-Shirt|Polo|Top|Tank|Vest/i,
    assignTo: 'sport-and-active/performance-tops',
    rationale: 'Technical performance tops',
  },
  {
    categorisationContains: 'Football|Rugby|Cricket|Tennis|Basketball|Hockey',
    productType: /T-Shirt|Polo|Shirt|Top|Tank|Vest|Jersey/i,
    assignTo: 'sport-and-active/team-kit',
    rationale: 'Team-sport upper-body kit',
  },
  {
    categorisationContains: 'Football|Rugby|Cricket|Tennis|Basketball|Hockey',
    assignTo: 'sport-and-active/team-kit',
    rationale: 'Team-sport fallback',
  },
  {
    categorisationContains: 'Training|Tracksuit',
    productType: /Jogger|Pant|Trouser|Short|Legging/i,
    assignTo: 'sport-and-active/training-bottoms',
    rationale: 'Tracksuit / training bottoms',
  },
  {
    categorisationContains: 'Sport|Sports|Active',
    productType: /Jacket/i,
    assignTo: 'sport-and-active/sports-jackets',
    rationale: 'Sports-context jackets',
  },

  // ───────────────────────────────────────────────────────────
  // 4. Outerwear — by type, after the sport/safety contexts.
  // ───────────────────────────────────────────────────────────
  {
    productType: /Bodywarmer|Body Warmer|Gilet/i,
    assignTo: 'outerwear/gilets-and-bodywarmers',
  },
  {
    categorisationContains: 'Bodywarmer|Gilet',
    assignTo: 'outerwear/gilets-and-bodywarmers',
  },
  {
    productType: /Fleece/i,
    assignTo: 'outerwear/fleeces',
  },
  {
    categorisationContains: 'Fleece',
    assignTo: 'outerwear/fleeces',
  },
  {
    productType: /Softshell|Soft Shell/i,
    assignTo: 'outerwear/softshells',
  },
  {
    categorisationContains: 'Softshell|Soft Shell',
    assignTo: 'outerwear/softshells',
  },
  {
    productType: /Waterproof|Rainwear|Rain Jacket|Rain Coat|Cagoule|Anorak/i,
    assignTo: 'outerwear/waterproofs',
  },
  {
    categorisationContains: 'Waterproof|Rainwear',
    assignTo: 'outerwear/waterproofs',
  },
  {
    productType: /Jacket|Coat|Parka|Bomber|Puffer|Padded/i,
    assignTo: 'outerwear/jackets-and-coats',
  },
  {
    categorisationContains: 'Jacket|Coat',
    assignTo: 'outerwear/jackets-and-coats',
  },

  // ───────────────────────────────────────────────────────────
  // 5. Bags & Accessories.
  // ───────────────────────────────────────────────────────────
  {
    productType: /Rucksack|Backpack|Holdall|Duffel|Duffle|Kit Bag|Sports Bag/i,
    assignTo: 'bags-and-accessories/rucksacks-and-holdalls',
  },
  {
    categorisationContains: 'Rucksack|Backpack|Holdall',
    assignTo: 'bags-and-accessories/rucksacks-and-holdalls',
  },
  {
    productType: /Tote|Shopper|Cotton Bag|Canvas Bag/i,
    assignTo: 'bags-and-accessories/tote-and-shopper-bags',
  },
  {
    categorisationContains: 'Tote|Shopper',
    assignTo: 'bags-and-accessories/tote-and-shopper-bags',
  },
  {
    productType: /Cap|Hat|Beanie|Bobble|Bucket Hat|Headwear|Visor|Snapback/i,
    assignTo: 'bags-and-accessories/headwear',
  },
  {
    categorisationContains: 'Headwear|Cap|Hat|Beanie',
    assignTo: 'bags-and-accessories/headwear',
  },
  {
    productType: /Glove|Scarf|Snood|Neckwarmer|Neck Warmer|Mitten/i,
    assignTo: 'bags-and-accessories/gloves-and-scarves',
  },
  {
    categorisationContains: 'Glove|Scarf|Snood',
    assignTo: 'bags-and-accessories/gloves-and-scarves',
  },
  {
    productType: /Belt|Sock|Tie|Cufflinks/i,
    assignTo: 'bags-and-accessories/belts-and-socks',
  },
  {
    categorisationContains: 'Belt|Sock|Tie',
    assignTo: 'bags-and-accessories/belts-and-socks',
  },
  {
    productType: /Bag\b/i,
    assignTo: 'bags-and-accessories/rucksacks-and-holdalls',
    rationale: 'Generic "Bag" fallback into rucksacks-and-holdalls',
  },

  // ───────────────────────────────────────────────────────────
  // 6. Bottoms — by garment type.
  // ───────────────────────────────────────────────────────────
  {
    productType: /Jogger|Joggers|Track Pant|Tracksuit Bottom|Sweatpant/i,
    assignTo: 'bottoms/joggers',
  },
  {
    productType: /Legging/i,
    assignTo: 'bottoms/leggings',
  },
  {
    productType: /Skirt/i,
    assignTo: 'bottoms/skirts',
  },
  {
    productType: /Short\b|Shorts/i,
    assignTo: 'bottoms/shorts',
  },
  {
    productType: /Trouser|Pant\b|Pants|Chino/i,
    assignTo: 'bottoms/trousers',
  },

  // ───────────────────────────────────────────────────────────
  // 7. Tops — by garment type. Hoodies and sweatshirts before
  //    generic "shirt" so they don't get misfiled.
  // ───────────────────────────────────────────────────────────
  {
    productType: /Hoodie|Hooded Sweat|Hooded Top|Hooded Jumper/i,
    assignTo: 'tops/hoodies',
  },
  {
    productType: /Sweatshirt|Crew Neck|Crewneck|Sweater|Jumper/i,
    assignTo: 'tops/sweatshirts',
  },
  {
    productType: /Polo|Pique/i,
    assignTo: 'tops/polo-shirts',
  },
  {
    productType: /Vest|Tank Top|Tank|Singlet/i,
    assignTo: 'tops/vests-and-tank-tops',
  },
  {
    productType: /T-Shirt|Tee Shirt|Tee\b|T Shirt/i,
    assignTo: 'tops/t-shirts',
  },
  {
    productType: /\bShirt\b/i,
    assignTo: 'tops/shirts',
  },

  // ───────────────────────────────────────────────────────────
  // 8. Categorisation fallbacks for the long tail.
  // ───────────────────────────────────────────────────────────
  {
    categorisationContains: 'Hoodie',
    assignTo: 'tops/hoodies',
  },
  {
    categorisationContains: 'Sweatshirt',
    assignTo: 'tops/sweatshirts',
  },
  {
    categorisationContains: 'Polo',
    assignTo: 'tops/polo-shirts',
  },
  {
    categorisationContains: 'T-Shirt|T Shirt|Tee',
    assignTo: 'tops/t-shirts',
  },
  {
    categorisationContains: 'Shirt',
    assignTo: 'tops/shirts',
  },
];

// ============================================================
// Validation — fail-fast on bad slug paths in rules
// ============================================================

/** Validate every rule's `assignTo` against the taxonomy. Run at
 *  module load so a typo in a slug path crashes startup, not silently
 *  pushes products into nowhere. */
function validateRules(rules: MappingRule[]): void {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    const entry = findTaxonomyEntry(r.assignTo);
    if (!entry) {
      throw new Error(
        `category-mapping: rule[${i}] assigns to unknown slug path "${r.assignTo}". ` +
          `Available top-level slugs: ${TAXONOMY.map((t) => t.slug).join(', ')}.`,
      );
    }
  }
}
validateRules(RULES);

// ============================================================
// Evaluator
// ============================================================

/**
 * Evaluate the rules against a product's facts. Returns the slug path
 * of the first matching rule, or null if nothing matches (caller
 * routes to `uncategorised`).
 */
export function evaluateRules(facts: ProductFacts, rules: MappingRule[] = RULES): string | null {
  for (const r of rules) {
    if (r.source && facts.source !== r.source) continue;
    if (r.ageGroupEquals) {
      const got = (facts.ageGroup ?? '').trim();
      if (!equalIgnoreCase(got, r.ageGroupEquals)) continue;
    }
    if (r.productType) {
      const got = (facts.productType ?? '').trim();
      if (!r.productType.test(got)) continue;
    }
    if (r.categorisationContains) {
      const got = (facts.categorisation ?? '').toLowerCase();
      if (!got) continue;
      const tokens = r.categorisationContains.toLowerCase().split('|');
      if (!tokens.some((tok) => got.includes(tok))) continue;
    }
    if (r.nameContains) {
      const got = (facts.name ?? '').trim();
      if (!r.nameContains.test(got)) continue;
    }
    // A rule with NO predicates would match anything — guard against
    // accidentally adding such a rule.
    const hasAnyPredicate = Boolean(
      r.source ?? r.productType ?? r.categorisationContains ?? r.nameContains ?? r.ageGroupEquals,
    );
    if (!hasAnyPredicate) continue;
    return r.assignTo;
  }
  return null;
}

function equalIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
