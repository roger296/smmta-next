/**
 * Payment-timing rule (SPEC §16.1). Pure. Any line with an ETA beyond
 * `bankOnlyEtaDays` (default 30) forces the whole order to bank-payment-only;
 * evaluated per order, at order time. Boundary: exactly 30 days is NOT
 * >30-day, so a 30-day pool still gets the full method set.
 */

export interface PaymentLine {
  /** Days to ETA for a pre-order pool; null for an in-stock/warehouse line. */
  daysToEta: number | null;
}

export const FULL_METHOD_SET = ['creditcard', 'applepay', 'paypal', 'banktransfer', 'ideal'] as const;
export const BANK_ONLY_METHODS = ['banktransfer'] as const;

/** True when any line's ETA is strictly beyond the bank-only threshold. */
export function isBankOnlyOrder(lines: PaymentLine[], bankOnlyEtaDays = 30): boolean {
  return lines.some((l) => l.daysToEta != null && l.daysToEta > bankOnlyEtaDays);
}

export function offeredMethods(lines: PaymentLine[], bankOnlyEtaDays = 30): readonly string[] {
  return isBankOnlyOrder(lines, bankOnlyEtaDays) ? BANK_ONLY_METHODS : FULL_METHOD_SET;
}

const CARD_METHODS = new Set(['creditcard', 'applepay']);

/** A card method is not permitted on a bank-only order (§16.1). */
export function isMethodAllowed(
  method: string,
  lines: PaymentLine[],
  bankOnlyEtaDays = 30,
): boolean {
  if (isBankOnlyOrder(lines, bankOnlyEtaDays)) return !CARD_METHODS.has(method) && method !== 'paypal';
  return true;
}
