/**
 * Country names for supplier order payloads. Both Uneek and Ralawise take a
 * country code and a country name; our addresses hold only the code.
 */
const COUNTRY_NAMES: Record<string, string> = {
  GB: 'United Kingdom',
  UK: 'United Kingdom',
  IE: 'Ireland',
};

export function countryNameFor(code: string): string {
  const upper = code.trim().toUpperCase();
  return COUNTRY_NAMES[upper] ?? upper;
}

/** ISO code for an address country; "UK" is the common non-ISO spelling. */
export function countryCodeFor(code: string): string {
  const upper = code.trim().toUpperCase();
  return upper === 'UK' ? 'GB' : upper;
}
