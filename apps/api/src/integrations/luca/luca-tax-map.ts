import { VatTreatment } from '@smmta/shared-types';

/**
 * Maps the app's VatTreatment enum to Luca's tax_code values.
 *
 * Luca tax codes from gl_post_transaction:
 *   STANDARD_VAT_20, REDUCED_VAT_5, ZERO_RATED,
 *   EXEMPT, OUTSIDE_SCOPE, REVERSE_CHARGE, POSTPONED_VAT
 *
 * Our VatTreatment enum uses identical strings, so the mapping
 * is 1:1. This function exists for explicitness and future-proofing.
 */

const VAT_TO_LUCA_TAX_CODE: Record<VatTreatment, string> = {
  [VatTreatment.STANDARD_VAT_20]: 'STANDARD_VAT_20',
  [VatTreatment.REDUCED_VAT_5]: 'REDUCED_VAT_5',
  [VatTreatment.ZERO_RATED]: 'ZERO_RATED',
  [VatTreatment.EXEMPT]: 'EXEMPT',
  [VatTreatment.OUTSIDE_SCOPE]: 'OUTSIDE_SCOPE',
  [VatTreatment.REVERSE_CHARGE]: 'REVERSE_CHARGE',
  [VatTreatment.POSTPONED_VAT]: 'POSTPONED_VAT',
};

/**
 * Returns the Luca tax_code string for a given VatTreatment.
 */
export function vatTreatmentToLucaTaxCode(treatment: VatTreatment): string {
  return VAT_TO_LUCA_TAX_CODE[treatment];
}

/**
 * Returns the VAT rate percentage for a given treatment.
 * Used when calculating tax amounts locally before posting.
 */
export function vatTreatmentToRate(treatment: VatTreatment): number {
  switch (treatment) {
    case VatTreatment.STANDARD_VAT_20: return 20;
    case VatTreatment.REDUCED_VAT_5: return 5;
    default: return 0;
  }
}
