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
 *   2. **Accessories and footwear before age.** A kids' cap is still
 *      headwear and a junior backpack is still a bag: those categories
 *      serve every age, while the kids' categories are for clothing.
 *
 *   3. **Age wins over context for kids.** A kid's hoodie lives in
 *      Kids & Schoolwear → Kids' tops, not Tops → Hoodies. Kids and
 *      adults shop on different pages. Only clothing goes there: a
 *      soft toy with a children's age group stays uncategorised.
 *
 *   4. **Garment-type fallthrough at the bottom.** Once context and
 *      age are exhausted, the regex on `productType` does the bulk
 *      of the work for ordinary apparel.
 *
 *   5. **Last rule must be a catch-all? No.** We deliberately don't
 *      add a last-resort rule — anything unmatched lands in
 *      `Uncategorised`, which is the signal to add more rules. The
 *      backfill's end-of-run summary tells the operator how big that
 *      bucket is.
 *
 * Supplier types are plural ("Hoodies", "Bags", "Scarves"), so type and
 * name patterns allow plurals. Categorisation tokens match whole words:
 * the full Ralawise Categorisation is a long list of collection names,
 * in which a substring such as "pe" or "tie" turns up everywhere, and
 * sport words there often name a merchandise collection rather than kit.
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
  /** `'Adult' | 'Child' | 'Baby'` — Ralawise col 30, via normaliseAgeGroup. */
  ageGroup?: string | null;
  /** Product name — fallback when nothing else fires (e.g. "rugby
   *  shirt" → tops/shirts). */
  name?: string | null;
}

const AGE_GROUPS: Record<string, string> = {
  adult: 'Adult',
  adults: 'Adult',
  teen: 'Teen',
  teens: 'Teen',
  child: 'Child',
  children: 'Child',
  kid: 'Child',
  kids: 'Child',
  junior: 'Child',
  baby: 'Baby',
  babies: 'Baby',
  infant: 'Baby',
  infants: 'Baby',
  toddler: 'Baby',
};

/**
 * A supplier's age label in the terms the rules use. Ralawise says "Kids"
 * and "Infant" where the rules say "Child" and "Baby". Unknown labels
 * pass through unchanged.
 */
export function normaliseAgeGroup(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  return AGE_GROUPS[v.toLowerCase()] ?? v;
}

export interface MappingRule {
  /** Optional source filter — when set, the rule only fires for the
   *  named supplier. Most rules apply to both. */
  source?: 'ralawise' | 'uneek';
  productType?: RegExp;
  /** Whole words against the supplier's categorisation string, case-
   *  insensitive, a plural allowed ("Tie" matches "Ties" but not
   *  "Varieties"). Multiple tokens with `|` are OR-ed. */
  categorisationContains?: string;
  /** Regex against the product name — last-resort matching for products
   *  with no structured type. */
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
  //    or straight from the product name, so both are checked.
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
    productType: /\bSafety Vests?\b/i,
    assignTo: 'workwear-and-safety/hi-vis-tops-and-vests',
    rationale: 'Safety vests are hi-vis by definition',
  },
  {
    categorisationContains: 'Hi-Vis|Hi Vis|HiVis|High Visibility',
    assignTo: 'workwear-and-safety/hi-vis-tops-and-vests',
    rationale: 'Hi-vis fallback via categorisation column',
  },
  {
    productType: /\b(Coveralls?|Overalls?|Boiler ?suits?)\b/i,
    assignTo: 'workwear-and-safety/overalls-and-coveralls',
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
  // 2. Bags & Accessories — whatever the age. Matched on the
  //    supplier's product type only: accessory words in a long
  //    categorisation string are too often collection names.
  // ───────────────────────────────────────────────────────────
  {
    productType: /\b(Rucksacks?|Backpacks?|Holdalls?|Duffel|Duffle|Kit Bags?|Sports Bags?|Gymsacs?|Drawstring Bags?)\b/i,
    assignTo: 'bags-and-accessories/rucksacks-and-holdalls',
  },
  {
    productType: /\b(Totes?|Shoppers?|Cotton Bags?|Canvas Bags?)\b/i,
    assignTo: 'bags-and-accessories/tote-and-shopper-bags',
  },
  {
    productType: /\bBags?\b/i,
    nameContains: /\b(totes?|shoppers?|shopping)\b/i,
    assignTo: 'bags-and-accessories/tote-and-shopper-bags',
    rationale: 'Generic "Bags" type named as a tote or shopper',
  },
  {
    productType: /\bBags?\b/i,
    assignTo: 'bags-and-accessories/rucksacks-and-holdalls',
    rationale: 'Generic "Bags" fallback into rucksacks-and-holdalls',
  },
  {
    productType: /\b(Caps?|Hats?|Beanies?|Bobbles?|Headwear|Visors?|Snapbacks?|Headbands?)\b/i,
    assignTo: 'bags-and-accessories/headwear',
  },
  {
    productType: /\b(Gloves?|Scarf|Scarfs|Scarves|Snoods?|Neck ?warmers?|Mittens?)\b/i,
    assignTo: 'bags-and-accessories/gloves-and-scarves',
  },
  {
    productType: /\b(Belts?|Socks?|Ties?|Cufflinks|Braces)\b/i,
    assignTo: 'bags-and-accessories/belts-and-socks',
  },

  // ───────────────────────────────────────────────────────────
  // 3. Footwear — whatever the age. Safety footwear first: the
  //    supplier's own type says only Boots, Trainers or Shoes, so
  //    safety is read from the name ("safety", a steel or composite
  //    toe, or an EN ISO 20345 rating such as S1P, S3 or SB).
  // ───────────────────────────────────────────────────────────
  {
    productType: /\b(Boots?|Trainers?|Shoes?|Clogs?|Footwear)\b/i,
    nameContains: /\b(safety|S1P?|S2|S3|S4|S5|S6|S7|SB|SBP|steel|steelite|composite|toe ?caps?)\b/i,
    assignTo: 'footwear/safety-footwear',
    rationale: 'Safety boots, trainers and shoes — by name or safety rating',
  },
  {
    productType: /\bTrainers?\b/i,
    assignTo: 'footwear/trainers',
  },
  {
    productType: /\b(Sliders?|Slides?|Slippers?|Sandals?|Flip ?flops?)\b/i,
    assignTo: 'footwear/sliders-and-slippers',
  },
  {
    productType: /\b(Boots?|Shoes?|Clogs?|Footwear)\b/i,
    assignTo: 'footwear/boots-and-shoes',
  },

  // ───────────────────────────────────────────────────────────
  // 4. Kids & Schoolwear — age wins over garment type.
  //    Age group isn't always available (Uneek has none), so we
  //    also detect by name patterns (Kids/Junior/Children/Toddler/Baby).
  // ───────────────────────────────────────────────────────────
  {
    nameContains: /\b(baby|babies|toddlers?|infants?|newborns?)\b/i,
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
    nameContains: /\b(kids|kid'?s|childrens?|child'?s|junior)\b.*\b(jackets?|coats?|fleeces?|bodywarmers?|gilets?|softshells?|waterproofs?|anoraks?|parkas?|windbreakers?)\b/i,
    assignTo: 'kids-and-schoolwear/kids-outerwear',
    rationale: "Kids' outerwear — by name",
  },
  {
    nameContains: /\b(kids|kid'?s|childrens?|child'?s|junior)\b.*\b(trousers?|shorts?|joggers?|leggings?|skirts?|skorts?|pants?|sweatpants?|jeans)\b/i,
    assignTo: 'kids-and-schoolwear/kids-bottoms',
    rationale: "Kids' bottoms — by name",
  },
  {
    ageGroupEquals: 'Child',
    categorisationContains: 'Sport|Sports|PE|Rugby|Football|Cricket|Tennis',
    assignTo: 'kids-and-schoolwear/school-sports-kit',
    rationale: "Kids' sportswear → school sports kit",
  },
  {
    ageGroupEquals: 'Child',
    productType: /Jacket|Coat|Fleece|Bodywarmer|Body Warmer|Gilet|Softshell|Waterproof|Anorak|Rain/i,
    assignTo: 'kids-and-schoolwear/kids-outerwear',
    rationale: "Kids' outer layers",
  },
  {
    ageGroupEquals: 'Child',
    productType: /Trouser|Short|Jogger|Legging|Skirt|Skort|Pant|Jean|Chino/i,
    assignTo: 'kids-and-schoolwear/kids-bottoms',
    rationale: "Kids' lower-body wear",
  },
  {
    ageGroupEquals: 'Child',
    productType: /T-Shirt|Polo|Hoodie|Sweatshirt|Shirt|Tank|Vest|Jumper|Blouse|Cardigan|Top\b/i,
    assignTo: 'kids-and-schoolwear/kids-tops',
    rationale: "Kids' upper-body wear",
  },
  {
    ageGroupEquals: 'Child',
    productType: /\b(Onesies?|All-in-ones?|Robes?|Ponchos?|Pyjamas?|Dress|Dresses|Baselayers?|Base Layers?|Trackwear)\b/i,
    assignTo: 'kids-and-schoolwear/kids-tops',
    rationale: "Kids' other clothing. Not a catch-all: toys and gifts stay uncategorised",
  },
  {
    nameContains: /\b(kids|kid'?s|childrens?|child'?s|junior|schoolwear)\b/i,
    assignTo: 'kids-and-schoolwear/kids-tops',
    rationale: "Kids' wear with no age group or garment signal — by name",
  },

  // ───────────────────────────────────────────────────────────
  // 5. Dresses — after the kids' rules, so children's dresses stay
  //    with kids' clothing.
  // ───────────────────────────────────────────────────────────
  {
    productType: /\b(Dress|Dresses)\b/i,
    assignTo: 'dresses',
  },

  // ───────────────────────────────────────────────────────────
  // 6. Sport & Active.
  // ───────────────────────────────────────────────────────────
  {
    categorisationContains: 'Performance|Cooltex|Wicking|Quick Dry',
    productType: /T-Shirt|Polo|Top|Tank|Vest/i,
    assignTo: 'sport-and-active/performance-tops',
    rationale: 'Technical performance tops',
  },
  {
    productType: /\b(Rugby Shirts?|Football Shirts?|Jerseys?)\b/i,
    assignTo: 'sport-and-active/team-kit',
    rationale: 'Team-sport shirts by type (sport words in collection names are too often merchandise)',
  },
  {
    categorisationContains: 'Training|Tracksuit',
    productType: /Jogger|Pant|Trouser|Short|Legging/i,
    assignTo: 'sport-and-active/training-bottoms',
    rationale: 'Tracksuit / training bottoms',
  },
  {
    productType: /\bTrackwear\b/i,
    nameContains: /\b(pants?|bottoms?|joggers?|trousers?)\b/i,
    assignTo: 'sport-and-active/training-bottoms',
    rationale: 'Tracksuit bottoms',
  },
  {
    productType: /\b(Trackwear|Track Jackets?)\b/i,
    assignTo: 'sport-and-active/sports-jackets',
    rationale: 'Tracksuit tops and track jackets',
  },
  {
    categorisationContains: 'Sport|Sports|Active',
    productType: /Jacket/i,
    assignTo: 'sport-and-active/sports-jackets',
    rationale: 'Sports-context jackets',
  },
  {
    productType: /\b(Sports Overtops?|Baselayers?|Base Layers?|Bras?|Unitards?)\b/i,
    assignTo: 'sport-and-active/performance-tops',
    rationale: 'Sports overtops, baselayers, bras and unitards (activewear in the supplier ranges)',
  },

  // ───────────────────────────────────────────────────────────
  // 7. Outerwear — by type, after the sport/safety contexts.
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
    productType: /Waterproof|Rainwear|Rain Jacket|Rain Coat|Rain Suit|Cagoule|Anorak/i,
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
  // 8. Bottoms — by garment type.
  // ───────────────────────────────────────────────────────────
  {
    productType: /Jogger|Joggers|Track Pant|Tracksuit Bottom|Sweatpant|Loungewear Bottom|Lounge Pant/i,
    assignTo: 'bottoms/joggers',
  },
  {
    productType: /Legging/i,
    assignTo: 'bottoms/leggings',
  },
  {
    productType: /Skirt|Skort/i,
    assignTo: 'bottoms/skirts',
  },
  {
    productType: /Short\b|Shorts/i,
    assignTo: 'bottoms/shorts',
  },
  {
    productType: /Trouser|Pant\b|Pants|Chino|Jeans?\b/i,
    assignTo: 'bottoms/trousers',
  },

  // ───────────────────────────────────────────────────────────
  // 9. Tops — by garment type. Hoodies and sweatshirts before
  //    generic "shirt" so they don't get misfiled.
  // ───────────────────────────────────────────────────────────
  {
    productType: /Hoodie|Hooded Sweat|Hooded Top|Hooded Jumper/i,
    assignTo: 'tops/hoodies',
  },
  {
    productType: /Sweatshirt|Crew Neck|Crewneck|Sweater|Jumper|Cardigan/i,
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
    productType: /\b(Shirts?|Blouses?|Tunics?)\b/i,
    assignTo: 'tops/shirts',
  },

  // ───────────────────────────────────────────────────────────
  // 10. Categorisation fallbacks for the long tail.
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
      const got = facts.categorisation ?? '';
      if (!got) continue;
      const tokens = r.categorisationContains.split('|');
      if (!tokens.some((tok) => containsWord(got, tok))) continue;
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

const wordPatterns = new Map<string, RegExp>();

/**
 * True when `token` appears in `text` as a whole word or phrase, case-
 * insensitive, optionally pluralised: "Tie" matches "Ties" and "Silk Tie",
 * not "Varieties"; "PE" matches "PE Kit", not "Performance".
 */
export function containsWord(text: string, token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  let pattern = wordPatterns.get(t);
  if (!pattern) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`(^|[^a-z0-9])${escaped}(e?s)?(?=[^a-z0-9]|$)`, 'i');
    wordPatterns.set(t, pattern);
  }
  return pattern.test(text);
}
