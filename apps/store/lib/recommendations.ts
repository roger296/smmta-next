/**
 * Suggestions for a customer's order: ranges they did not buy, chosen to be
 * close to what they did, plus our stores.
 *
 * Shown in the shipped email and on the order's track page. The first pick is
 * another range in a material they bought (PLA Silk for a PLA Basic buyer);
 * the second is a neighbouring material they have not bought (TPU for a PLA
 * buyer). Only ranges that can be bought now are suggested. Carbon-fibre
 * ranges need a hardened nozzle, so they are only suggested to customers who
 * have bought one, unless nothing else is left.
 *
 * Pure: the caller fetches the order and the catalogue.
 */
import type { GroupListItem } from './api-types';
import { groupMatchesMaterial, MATERIALS } from './materials';
import { rangeCopyFor } from './range-copy';

export interface Recommendation {
  groupId: string;
  name: string;
  /** Path on this store, e.g. `/shop/landau-pla-silk-1-75mm-1kg`. */
  path: string;
  imageUrl: string | null;
  /** The lowest min price of the range's products, e.g. "£11.99". */
  priceFrom: string | null;
  /** Why it was picked, e.g. "Try TPU". */
  eyebrow: string;
  blurb: string;
  /** Material code, e.g. "PLA", when one is recognised. */
  material: string | null;
}

export interface OrderForRecommendations {
  lines: Array<{ groupId?: string | null; productName?: string | null }>;
}

/** Neighbouring materials, nearest first. */
const RELATED_MATERIALS: Record<string, string[]> = {
  PLA: ['TPU', 'PETG', 'ASA', 'ABS'],
  PETG: ['TPU', 'ASA', 'PLA', 'ABS'],
  ABS: ['ASA', 'PETG', 'TPU', 'PLA'],
  ASA: ['ABS', 'PETG', 'TPU', 'PLA'],
  TPU: ['PETG', 'PLA', 'ASA', 'ABS'],
};

const CARBON = /carbon|\bcf\b/i;
const BLURB_MAX = 120;

/** The material a range is made of: from its range copy, else from its name. */
export function materialOfGroup(group: { name: string; slug?: string | null }): string | null {
  const slug = rangeCopyFor(group.slug)?.material;
  const fromCopy = slug ? MATERIALS.find((m) => m.slug === slug) : undefined;
  if (fromCopy) return fromCopy.code;
  return MATERIALS.find((m) => groupMatchesMaterial(group.name, m.code))?.code ?? null;
}

function buyable(g: GroupListItem): boolean {
  return (
    g.totalAvailableQty > 0 ||
    g.variants.some((v) => v.availableQty > 0 || v.stockState === 'AVAILABLE_FROM_SUPPLIER')
  );
}

/** The lowest min price (priceGbp, the products' min selling price) in the range. */
function priceFrom(g: GroupListItem): string | null {
  const prices = g.variants
    .map((v) => Number.parseFloat(v.priceGbp ?? ''))
    .filter((n) => Number.isFinite(n) && n > 0);
  return prices.length > 0 ? `£${Math.min(...prices).toFixed(2)}` : null;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, '')}…`;
}

/** One line per material, for a range with no copy of its own. */
const MATERIAL_PITCH: Record<string, string> = {
  PLA: 'The easy one. Crisp detail and a clean finish on almost any printer.',
  PETG: 'Tougher than PLA and happy in the heat, for parts that have to do a job.',
  ABS: 'Heat and impact resistant, for mechanical parts. Print it enclosed.',
  ASA: 'Weatherproof and UV-stable, for anything that lives outdoors.',
  TPU: 'Flexible filament for grips, gaskets, feet and cases.',
};

function blurbFor(g: GroupListItem, material: string | null): string {
  const text =
    rangeCopyFor(g.slug)?.summary ||
    g.shortDescription?.trim() ||
    (material ? MATERIAL_PITCH[material] : undefined) ||
    '';
  return truncate(text, BLURB_MAX);
}

interface Candidate {
  group: GroupListItem & { slug: string };
  material: string | null;
  carbon: boolean;
}

export function pickRecommendations(
  order: OrderForRecommendations,
  groups: GroupListItem[],
  limit = 2,
): Recommendation[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const boughtIds = new Set(order.lines.map((l) => l.groupId).filter((id): id is string => Boolean(id)));
  // A line without a group id is matched by name, so "Landau PLA Silk 1.75mm
  // 1kg — Gold" still rules out the PLA Silk range.
  const ungroupedNames = order.lines
    .filter((l) => !l.groupId && l.productName)
    .map((l) => l.productName!.toLowerCase());

  const bought: string[] = [];
  let boughtCarbon = false;
  for (const line of order.lines) {
    const group = line.groupId ? byId.get(line.groupId) : undefined;
    const subject = group ?? { name: line.productName ?? '', slug: null };
    const code = materialOfGroup(subject);
    if (code && !bought.includes(code)) bought.push(code);
    if (CARBON.test(subject.name)) boughtCarbon = true;
  }

  const candidates: Candidate[] = groups
    .filter((g): g is GroupListItem & { slug: string } => Boolean(g.slug))
    .filter((g) => buyable(g) && !boughtIds.has(g.id))
    .filter((g) => !ungroupedNames.some((n) => n.startsWith(g.name.toLowerCase())))
    .map((g) => ({ group: g, material: materialOfGroup(g), carbon: CARBON.test(g.name) }))
    .sort(
      (a, b) =>
        Number(!a.group.heroImageUrl) - Number(!b.group.heroImageUrl) ||
        a.group.sortOrder - b.group.sortOrder ||
        a.group.name.localeCompare(b.group.name),
    );

  const picks: Array<{ candidate: Candidate; eyebrow: string }> = [];
  const suits = (c: Candidate) => boughtCarbon || !c.carbon;
  const next = (test: (c: Candidate) => boolean) =>
    candidates.find((c) => test(c) && !picks.some((p) => p.candidate === c));

  // 1. Another range in a material they bought.
  for (const code of bought) {
    if (picks.length >= limit) break;
    const c = next((x) => x.material === code && suits(x));
    if (c) {
      picks.push({ candidate: c, eyebrow: `Your next ${code}` });
      break;
    }
  }

  // 2. A neighbouring material they have not bought.
  related: for (const code of bought) {
    for (const other of RELATED_MATERIALS[code] ?? []) {
      if (picks.length >= limit) break related;
      if (bought.includes(other)) continue;
      const c = next((x) => x.material === other && suits(x));
      if (c) {
        picks.push({ candidate: c, eyebrow: `Try ${other}` });
        break related;
      }
    }
  }

  // 3. Anything else that can be bought, a material not yet shown first.
  while (picks.length < limit) {
    const shown = new Set(picks.map((p) => p.candidate.material));
    const c =
      next((x) => !shown.has(x.material) && suits(x)) ?? next(suits) ?? next(() => true);
    if (!c) break;
    const eyebrow = !c.material
      ? 'Also in the store'
      : bought.includes(c.material)
        ? `Your next ${c.material}`
        : `Try ${c.material}`;
    picks.push({ candidate: c, eyebrow });
  }

  return picks.map(({ candidate: { group, material }, eyebrow }) => ({
    groupId: group.id,
    name: group.name,
    path: `/shop/${group.slug}`,
    imageUrl: group.heroImageUrl,
    priceFrom: priceFrom(group),
    eyebrow,
    blurb: blurbFor(group, material),
    material,
  }));
}

// ---------------------------------------------------------------------------
// Look and feel shared by the email and the track page.
// ---------------------------------------------------------------------------

/** Spool colours, used as a decorative strip. */
export const SPOOL_COLOURS = [
  '#E63946',
  '#F3722C',
  '#F9C74F',
  '#43AA8B',
  '#277DA1',
  '#9B5DE5',
  '#EF476F',
  '#15161A',
] as const;

/** A bright bar per material, and a darker shade that reads as text on white. */
const MATERIAL_ACCENTS: Record<string, { bar: string; ink: string }> = {
  PLA: { bar: '#43AA8B', ink: '#1F6F55' },
  PETG: { bar: '#277DA1', ink: '#1B5A75' },
  ABS: { bar: '#F3722C', ink: '#A2440F' },
  ASA: { bar: '#F9C74F', ink: '#7A5E00' },
  TPU: { bar: '#9B5DE5', ink: '#6A2FB5' },
};

export function accentFor(material: string | null): { bar: string; ink: string } {
  return (material && MATERIAL_ACCENTS[material]) || { bar: '#3B5266', ink: '#3B5266' };
}

export const CLOTHES_SHOP_URL = 'https://clothes.cleverdeals.net';

export interface StoreAdvert {
  name: string;
  url: string;
  host: string;
  strap: string;
  detail: string;
  cta: string;
  colours: { background: string; text: string; muted: string; button: string; buttonText: string };
  serif: boolean;
  spoolStrip: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** This store and its sister store, each in its own colours. */
export function storeAdverts(filamentStoreUrl: string): StoreAdvert[] {
  return [
    {
      name: 'Filament Store',
      url: filamentStoreUrl,
      host: hostOf(filamentStoreUrl),
      strap: 'Filament that prints first time.',
      detail: 'PLA, PETG, ABS, ASA and TPU. 1.75mm · 1kg · vacuum-sealed.',
      cta: 'Shop filament',
      colours: { background: '#15161A', text: '#FFFFFF', muted: '#B4C6D2', button: '#B4C6D2', buttonText: '#15161A' },
      serif: false,
      spoolStrip: true,
    },
    {
      name: 'Clothes Shop',
      url: CLOTHES_SHOP_URL,
      host: hostOf(CLOTHES_SHOP_URL),
      strap: 'Friendly clothes in real sizes.',
      detail: 'Fast UK delivery and easy returns. Pick your colour, pick your size.',
      cta: 'Shop clothes',
      colours: { background: '#E8537A', text: '#1F1B2E', muted: '#2B2238', button: '#1F1B2E', buttonText: '#FFFCF6' },
      serif: true,
      spoolStrip: false,
    },
  ];
}
