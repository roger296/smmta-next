/**
 * Interests (spec § Data model; Part B #16). A contact's interests are a map
 * of interest key → score as of a time. Scores halve every 180 days; an order,
 * pre-order, subscription or back-in-stock request adds 10, an email click 2;
 * a score of 3 or more is "interested".
 *
 * Keys, not category ids: filament products carry no material category, so a
 * product's keys come from its name (`material:pla`) plus its category when
 * it has one (`category:<id>`). This one function decides them, so orders,
 * clicks and digest blocks always agree.
 */
import type { InterestMap } from '../../../db/schema/email.js';

export interface InterestPolicy {
  halfLifeDays: number;
  orderPoints: number;
  clickPoints: number;
  threshold: number;
}

export const DEFAULT_INTEREST_POLICY: InterestPolicy = {
  halfLifeDays: 180,
  orderPoints: 10,
  clickPoints: 2,
  threshold: 3,
};

/** Materials, in match order: the longer and more specific codes first so
 *  "PLA" never matches inside "PLA+ Silk" before Silk does its job — every
 *  matching material is returned anyway. Codes follow apps/store/lib/materials.ts. */
export const MATERIALS = [
  { key: 'material:pla', name: 'PLA', pattern: /\bPLA\+?(?![A-Z])/i },
  { key: 'material:petg', name: 'PETG', pattern: /\bPETG\b/i },
  { key: 'material:abs', name: 'ABS', pattern: /\bABS\b/i },
  { key: 'material:asa', name: 'ASA', pattern: /\bASA\b/i },
  { key: 'material:tpu', name: 'TPU', pattern: /\bTPU\b/i },
  { key: 'material:nylon', name: 'Nylon', pattern: /\b(nylon|PA6|PA12)\b/i },
  { key: 'material:carbon', name: 'Carbon fibre', pattern: /\b(carbon|CF)\b/i },
  { key: 'material:silk', name: 'Silk', pattern: /\bsilk\b/i },
  { key: 'material:wood', name: 'Wood', pattern: /\bwood\b/i },
] as const;

export const MATERIAL_KEYS: string[] = MATERIALS.map((m) => m.key);

export function materialName(key: string): string | undefined {
  return MATERIALS.find((m) => m.key === key)?.name;
}

/** Interest keys for a product. */
export function interestKeysForProduct(p: {
  name?: string | null;
  groupName?: string | null;
  categoryId?: string | null;
}): string[] {
  const text = `${p.groupName ?? ''} ${p.name ?? ''}`;
  const keys: string[] = MATERIALS.filter((m) => m.pattern.test(text)).map((m) => m.key);
  if (p.categoryId) keys.push(`category:${p.categoryId}`);
  return [...new Set(keys)];
}

/** Interest keys named in free text (an import's list names). */
export function materialKeysInText(text: string): string[] {
  return MATERIALS.filter((m) => m.pattern.test(text)).map((m) => m.key);
}

const DAY_MS = 86_400_000;

export function effectiveScore(
  entry: { score: number; at: string } | undefined,
  now: Date,
  policy: InterestPolicy = DEFAULT_INTEREST_POLICY,
): number {
  if (!entry) return 0;
  const days = Math.max(0, (now.getTime() - Date.parse(entry.at)) / DAY_MS);
  return entry.score * Math.pow(0.5, days / policy.halfLifeDays);
}

/** A new map with `points` added to each key, decayed to `now` first. */
export function addInterestPoints(
  map: InterestMap,
  keys: string[],
  points: number,
  now: Date,
  policy: InterestPolicy = DEFAULT_INTEREST_POLICY,
): InterestMap {
  const out: InterestMap = { ...map };
  for (const key of keys) {
    const score = effectiveScore(out[key], now, policy) + points;
    out[key] = { score: round(score), at: now.toISOString() };
  }
  return out;
}

/** The map with every score decayed to `now` (scores under 0.05 dropped). */
export function decayAll(
  map: InterestMap,
  now: Date,
  policy: InterestPolicy = DEFAULT_INTEREST_POLICY,
): InterestMap {
  const out: InterestMap = {};
  for (const [key, entry] of Object.entries(map)) {
    const score = effectiveScore(entry, now, policy);
    if (score >= 0.05) out[key] = { score: round(score), at: now.toISOString() };
  }
  return out;
}

export function isInterested(
  map: InterestMap,
  key: string,
  now: Date,
  policy: InterestPolicy = DEFAULT_INTEREST_POLICY,
): boolean {
  return effectiveScore(map[key], now, policy) >= policy.threshold;
}

/** Keys the contact is interested in now. */
export function interestedKeys(
  map: InterestMap,
  now: Date,
  policy: InterestPolicy = DEFAULT_INTEREST_POLICY,
): string[] {
  return Object.keys(map).filter((k) => isInterested(map, k, now, policy));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
