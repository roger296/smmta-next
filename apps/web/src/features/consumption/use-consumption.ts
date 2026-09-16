import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/** Which benches a line answers for (Sept-2026, item 5). */
export const CONSUMPTION_SECTIONS = ['REGULAR', 'GLUTEN_FREE', 'VEGAN'] as const;
export type ConsumptionSection = (typeof CONSUMPTION_SECTIONS)[number];

export const SECTION_LABELS: Record<ConsumptionSection, string> = {
  REGULAR: 'Regular',
  GLUTEN_FREE: 'Gluten free',
  VEGAN: 'Vegan',
};

export interface ExpectedLine {
  productId: string;
  productName: string;
  qtyPerCover: number;
  expectedQty: number;
  stockUom: string;
  unitCost: number | null;
  expectedCost: number | null;
  /** Which benches this figure is for. Each section carries its FULL list. */
  section: ConsumptionSection;
  /** How many benches this section's figure covers. */
  benches: number;
  /** Which part of the cake (item 6). '' = unnamed. */
  component: string;
}

export interface ConsumptionLine {
  id: string;
  productId: string;
  expectedQty: string;
  actualQty: string;
  wastageQty: string;
  wastageReason: string | null;
  unitCost: string | null;
  variance: string;
  stockUom: string;
}

export interface ConsumptionRecord {
  id: string;
  siteId: string;
  sessionId: string;
  sessionDate: string;
  bakerName: string;
  bake: string | null;
  covers: number;
  version: number;
  materialsCost: string;
  submittedAt: string | null;
}

export interface AwaitingSession {
  sessionId: string;
  sessionDate: string;
  /** ISO start, when BumbleBee said. Null ⇒ no time to show. */
  startsAt: string | null;
  covers: number;
}

/**
 * Why the list is empty — which is a different question from whether it is.
 *
 * 'not_connected' — BumbleBee session polling is not wired up, so nothing was
 *   even asked for. That is the live state today.
 * 'live' — the feed answered; an empty list means nothing is outstanding.
 */
export type SessionFeedStatus = 'live' | 'not_connected';

export interface AwaitingSessions {
  sessions: AwaitingSession[];
  feedStatus: SessionFeedStatus;
}

/**
 * A session, as the venue picker shows it (Sept-2026, item 8 follow-up).
 *
 * A bare BumbleBee uuid is not something anybody recognises. The time is what
 * makes a sitting identifiable to the baker who just finished it; the guest
 * count is the confirmation.
 */
export function describeSession(s: AwaitingSession): string {
  // en-GB explicitly, not the device locale. A venue iPad handed out with US
  // regional settings would otherwise render "06:30 PM" on a British rota that
  // says 18:30 — and a baker matching a time against a printed sheet should
  // not have to translate it.
  const time = s.startsAt
    ? new Date(s.startsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null;
  const covers = s.covers > 0 ? `${s.covers} guest${s.covers === 1 ? '' : 's'}` : null;
  const parts = [time, covers].filter(Boolean);
  // Fall back to the id rather than rendering an empty chip — a row with no
  // label is not something a baker can choose between.
  return parts.length > 0 ? parts.join(' · ') : s.sessionId;
}

/**
 * A named reason a bake cannot be filed (Aug-2026 feedback, F-5 / F-6).
 * "No bake logs were submitted due to incorrect recipe data" — the old screen
 * showed a transient toast and an empty list, which reads as "nothing to do".
 */
export interface ExpectedBlocker {
  kind: 'NO_RECIPE' | 'NO_GF_VARIANT' | 'NO_VEGAN_VARIANT' | 'NO_INGREDIENTS';
  message: string;
}

export interface ExpectedResult {
  lines: ExpectedLine[];
  blockers: ExpectedBlocker[];
}

export interface ExpectedInput {
  siteId: string;
  onDate: string;
  bake: string;
  /** TOTAL tables. */
  covers: number;
  glutenFreeTables?: number;
  veganTables?: number;
}

/** Compute expected consumption for a session = recipe(cake) × covers. */
export function useExpectedConsumption() {
  return useMutation<ExpectedResult, Error, ExpectedInput>({
    mutationFn: (input) =>
      apiFetch<ExpectedResult>('/recipes/expected', { method: 'POST', body: input }),
  });
}

/** Which diets a cake has a recipe for, so the setup screen can say so (F-5). */
export interface DietaryCoverage {
  hasRecipe: boolean;
  glutenFree: boolean;
  vegan: boolean;
}

export function useDietaryCoverage(input: { siteId?: string; bake?: string; onDate?: string }) {
  return useQuery<DietaryCoverage>({
    queryKey: ['recipes', 'coverage', input.siteId, input.bake, input.onDate],
    queryFn: () =>
      apiFetch<DietaryCoverage>('/recipes/coverage', {
        searchParams: { siteId: input.siteId, bake: input.bake, onDate: input.onDate },
      }),
    enabled: !!input.siteId && !!input.bake && !!input.onDate,
  });
}

/** Submitted consumption records (newest first), optionally by site / date. */
export function useConsumptionList(filter?: { siteId?: string; sessionDate?: string }) {
  return useQuery<ConsumptionRecord[]>({
    queryKey: ['consumption', filter ?? {}],
    queryFn: () => apiFetch<ConsumptionRecord[]>('/session-consumption', { searchParams: filter }),
  });
}

/** Sessions at a site (for a date) with no consumption record yet. */
export function useSessionsAwaiting(siteId: string | undefined, date: string | undefined) {
  return useQuery<AwaitingSessions>({
    queryKey: ['consumption', 'awaiting', siteId, date],
    queryFn: () =>
      apiFetch<AwaitingSessions>('/session-consumption/awaiting', {
        searchParams: { siteId, date },
      }),
    enabled: !!siteId && !!date,
    // A venue iPad on bad wifi should fall through to typing the id, not sit
    // on a spinner. One try, then the screen offers the manual route.
    retry: 1,
  });
}

export interface SweepResult {
  date: string;
  sites: number;
  cogsPosted: number;
  wastagePosted: number;
  totalCogs: number;
  totalWastage: number;
}

/** Run the daily COGS / wastage Xero sweep for a date (dry-run by default). */
export function useConsumptionSweep() {
  const qc = useQueryClient();
  return useMutation<SweepResult, Error, { date: string }>({
    mutationFn: (input) => apiFetch<SweepResult>('/session-consumption/sweep', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consumption'] }),
  });
}
