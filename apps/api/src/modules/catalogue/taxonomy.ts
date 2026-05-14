/**
 * Clothes Shop category taxonomy.
 *
 * The seven top-tier categories + their subcategories + a hidden
 * `Uncategorised` bucket. Hand-curated; matches the brief in
 * `.tmp-claude-code-briefs-6.md` §I.
 *
 * Used by:
 *   - `seed-categories.ts` (idempotent upsert into the `categories` table)
 *   - `category-mapping.ts` (rules' `assignTo` field references these slugs)
 *   - The conversational-search parser (system prompt enumerates the slugs)
 *   - The admin SPA (read-only tree view)
 *
 * Two-tier hard cap. If a sub-bucket is unwieldy, the answer is
 * filters within the page, not more taxonomy depth.
 */

export interface TaxonomyTop {
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  isHidden?: boolean;
  children: TaxonomySub[];
}

export interface TaxonomySub {
  slug: string;
  name: string;
}

export const TAXONOMY: TaxonomyTop[] = [
  {
    slug: 'tops',
    name: 'Tops',
    sortOrder: 10,
    description:
      'T-shirts, polos, shirts, sweatshirts, hoodies, and vests. Everyday upper-body wear in real sizes.',
    children: [
      { slug: 't-shirts', name: 'T-shirts' },
      { slug: 'polo-shirts', name: 'Polo shirts' },
      { slug: 'shirts', name: 'Shirts' },
      { slug: 'sweatshirts', name: 'Sweatshirts' },
      { slug: 'hoodies', name: 'Hoodies' },
      { slug: 'vests-and-tank-tops', name: 'Vests & tank tops' },
    ],
  },
  {
    slug: 'outerwear',
    name: 'Outerwear',
    sortOrder: 20,
    description: 'Jackets, fleeces, bodywarmers, softshells, and waterproofs for all weather.',
    children: [
      { slug: 'jackets-and-coats', name: 'Jackets & coats' },
      { slug: 'fleeces', name: 'Fleeces' },
      { slug: 'gilets-and-bodywarmers', name: 'Gilets & bodywarmers' },
      { slug: 'softshells', name: 'Softshells' },
      { slug: 'waterproofs', name: 'Waterproofs' },
    ],
  },
  {
    slug: 'bottoms',
    name: 'Bottoms',
    sortOrder: 30,
    description: 'Trousers, shorts, joggers, leggings, and skirts.',
    children: [
      { slug: 'trousers', name: 'Trousers' },
      { slug: 'shorts', name: 'Shorts' },
      { slug: 'joggers', name: 'Joggers' },
      { slug: 'leggings', name: 'Leggings' },
      { slug: 'skirts', name: 'Skirts' },
    ],
  },
  {
    slug: 'workwear-and-safety',
    name: 'Workwear & Safety',
    sortOrder: 40,
    description:
      'Hi-vis, overalls, coveralls, work trousers, aprons, and tabards. Designed for working conditions, not just the office.',
    children: [
      { slug: 'hi-vis-tops-and-vests', name: 'Hi-vis tops & vests' },
      { slug: 'hi-vis-outerwear', name: 'Hi-vis outerwear' },
      { slug: 'overalls-and-coveralls', name: 'Overalls & coveralls' },
      { slug: 'work-trousers', name: 'Work trousers' },
      { slug: 'aprons-and-tabards', name: 'Aprons & tabards' },
    ],
  },
  {
    slug: 'sport-and-active',
    name: 'Sport & Active',
    sortOrder: 50,
    description: 'Performance tops, training bottoms, sports jackets, and team kit.',
    children: [
      { slug: 'performance-tops', name: 'Performance tops' },
      { slug: 'training-bottoms', name: 'Training bottoms' },
      { slug: 'sports-jackets', name: 'Sports jackets' },
      { slug: 'team-kit', name: 'Team kit' },
    ],
  },
  {
    slug: 'bags-and-accessories',
    name: 'Bags & Accessories',
    sortOrder: 60,
    description: 'Rucksacks, totes, headwear, gloves, scarves, belts, and socks.',
    children: [
      { slug: 'rucksacks-and-holdalls', name: 'Rucksacks & holdalls' },
      { slug: 'tote-and-shopper-bags', name: 'Tote & shopper bags' },
      { slug: 'headwear', name: 'Headwear' },
      { slug: 'gloves-and-scarves', name: 'Gloves & scarves' },
      { slug: 'belts-and-socks', name: 'Belts & socks' },
    ],
  },
  {
    slug: 'kids-and-schoolwear',
    name: 'Kids & Schoolwear',
    sortOrder: 70,
    description:
      "Kids' tops, bottoms, outerwear, school sports kit, and baby & toddler wear.",
    children: [
      { slug: 'kids-tops', name: "Kids' tops" },
      { slug: 'kids-bottoms', name: "Kids' bottoms" },
      { slug: 'kids-outerwear', name: "Kids' outerwear" },
      { slug: 'school-sports-kit', name: 'School sports kit' },
      { slug: 'baby-and-toddler', name: 'Baby & toddler' },
    ],
  },
  {
    slug: 'uncategorised',
    name: 'Uncategorised',
    sortOrder: 999,
    isHidden: true,
    description:
      "Fallback bucket for products the mapping rules haven't covered yet. Hidden from the storefront nav.",
    children: [],
  },
];

/**
 * Look up a top-tier + subcategory pair by their slug path (e.g.
 * `workwear-and-safety/hi-vis-tops-and-vests`). Returns null if
 * either segment is unknown. Top-only paths return the top-tier.
 */
export function findTaxonomyEntry(slugPath: string):
  | { top: TaxonomyTop; sub: TaxonomySub | null }
  | null {
  const [topSlug, subSlug] = slugPath.split('/');
  if (!topSlug) return null;
  const top = TAXONOMY.find((t) => t.slug === topSlug);
  if (!top) return null;
  if (!subSlug) return { top, sub: null };
  const sub = top.children.find((c) => c.slug === subSlug);
  if (!sub) return null;
  return { top, sub };
}

/** Flatten the taxonomy into every leaf slug-path (top/sub). Used by
 *  the conversational-search system prompt and by tests. */
export function allLeafSlugPaths(): string[] {
  const out: string[] = [];
  for (const top of TAXONOMY) {
    if (top.children.length === 0) {
      out.push(top.slug);
    } else {
      for (const sub of top.children) {
        out.push(`${top.slug}/${sub.slug}`);
      }
    }
  }
  return out;
}
