/**
 * Apply a part-unit (¼ / ½ / ¾) to a whole count, preserving the whole number.
 * Tapping the fraction that's already set clears it back to the whole number
 * (toggle), so 4 → ½ → 4.5 → ½ → 4.
 */
export function partUnit(current: number, fraction: number): number {
  const whole = Math.floor(current);
  const remainder = Math.round((current - whole) * 100) / 100;
  return Math.abs(remainder - fraction) < 0.001 ? whole : whole + fraction;
}
