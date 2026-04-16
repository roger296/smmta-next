/**
 * Generates a deterministic idempotency key for Luca GL postings.
 * Format: {prefix}-{entityId}-v{version}
 *
 * @param prefix - Posting type (CINV, CCN, SINV, SCN, CPAY, SPAY, GRN, COGS, SADJ, etc.)
 * @param entityId - The primary key of the source entity
 * @param version - Incrementing version (defaults to 1). Only bump if voiding and re-posting.
 */
export function glIdempotencyKey(
  prefix: string,
  entityId: string,
  version: number = 1,
): string {
  return `${prefix}-${entityId}-v${version}`;
}

/**
 * Derives the Luca accounting period_id from a date.
 * @returns "YYYY-MM" format string
 */
export function derivePeriodId(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}
