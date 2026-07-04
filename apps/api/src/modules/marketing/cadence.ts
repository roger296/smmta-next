/**
 * Purchase-cadence math (SPEC F7, §12.3 run-out-prediction). Pure. SQL-first,
 * LLM last — this is the "SQL" part: work out when a customer will run out from
 * their purchase history, with a minimum-data floor so a single purchase is
 * never extrapolated.
 */
const DAY_MS = 86_400_000;

/** Median gap between consecutive purchases, in days. null if < 2 purchases. */
export function medianIntervalDays(purchasesMs: number[]): number | null {
  if (purchasesMs.length < 2) return null;
  const sorted = [...purchasesMs].sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) intervals.push((sorted[i]! - sorted[i - 1]!) / DAY_MS);
  intervals.sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  return intervals.length % 2 ? intervals[mid]! : (intervals[mid - 1]! + intervals[mid]!) / 2;
}

export interface RunOutPrediction {
  medianIntervalDays: number;
  purchaseCount: number;
  lastPurchaseMs: number;
  predictedRunOutMs: number;
  regular: boolean;
}

/**
 * Predict the next run-out. Returns null when there is not enough data
 * (`minPurchases`, default 3) — a single or one-off purchase is excluded.
 * `regular` is true when the intervals are low-variance (coefficient of
 * variation < 0.5) — the signal the subscription-upsell segment keys on.
 */
export function predictRunOut(purchasesMs: number[], minPurchases = 3): RunOutPrediction | null {
  if (purchasesMs.length < minPurchases) return null;
  const median = medianIntervalDays(purchasesMs);
  if (median == null || median <= 0) return null;

  const sorted = [...purchasesMs].sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) intervals.push((sorted[i]! - sorted[i - 1]!) / DAY_MS);
  const mean = intervals.reduce((s, x) => s + x, 0) / intervals.length;
  const variance = intervals.reduce((s, x) => s + (x - mean) ** 2, 0) / intervals.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : Infinity;

  const lastPurchaseMs = sorted[sorted.length - 1]!;
  return {
    medianIntervalDays: median,
    purchaseCount: purchasesMs.length,
    lastPurchaseMs,
    predictedRunOutMs: lastPurchaseMs + median * DAY_MS,
    regular: cv < 0.5,
  };
}
