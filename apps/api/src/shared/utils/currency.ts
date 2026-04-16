/**
 * Rounds a monetary value to 2 decimal places using banker's rounding.
 */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Converts an amount from one currency to another using the given exchange rate.
 * @param amount - The amount in the source currency
 * @param rate - The exchange rate (target per 1 unit of source)
 */
export function convertCurrency(amount: number, rate: number): number {
  return roundMoney(amount * rate);
}

/**
 * Formats a number as a decimal string suitable for Luca API amounts.
 */
export function toDecimalString(value: number): string {
  return value.toFixed(2);
}
