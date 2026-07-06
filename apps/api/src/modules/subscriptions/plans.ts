/**
 * Subscription plan config (SPEC §15.4). Subscription benefit = bonus credit on
 * purchase (NOT a stacking %): £20/month → £23 credit, £50 → £59. Subscribers
 * spend credits at the same shelf/carton/pre-order prices as everyone else, so
 * there is no three-way discount algebra and no floor interaction.
 */
export interface Plan {
  key: string;
  monthlyChargePence: number;
  creditGrantPence: number;
}

export const PLANS: Record<string, Plan> = {
  starter: { key: 'starter', monthlyChargePence: 2000, creditGrantPence: 2300 }, // £20 → £23
  pro: { key: 'pro', monthlyChargePence: 5000, creditGrantPence: 5900 }, // £50 → £59
};

export function getPlan(key: string): Plan {
  const p = PLANS[key];
  if (!p) throw new Error(`unknown plan ${key}`);
  return p;
}

/** Days between renewals. */
export const RENEWAL_INTERVAL_DAYS = 30;
/** Dunning ladder (days after the first failure) then pause. */
export const DUNNING_LADDER_DAYS = [1, 3, 5];
