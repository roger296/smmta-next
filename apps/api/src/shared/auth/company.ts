/**
 * Singleton company-id helper.
 *
 * smmta-next is single-tenant per deployment: one business clones the
 * repo, runs their own instance, and every row in the database belongs
 * to a single `company_id`. The column stays in the schema as a
 * placeholder (so the door is open if multi-tenancy ever returns), but
 * no code enforces cross-tenant isolation any more.
 *
 * The singleton id is read from the `COMPANY_ID` environment variable
 * at first call. If unset, a fixed default (`11111111-1111-4111-8111-111111111111`)
 * is used — the same UUID the existing Filament Store deployment was
 * seeded with. Tests can set `process.env.COMPANY_ID` before importing
 * this module.
 *
 * The value is cached for the life of the process; call
 * `resetSingletonCompanyIdForTests()` from a test setup hook if you
 * need to flip it between suites.
 */

const DEFAULT_SINGLETON_COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cached: string | null = null;

export function getSingletonCompanyId(): string {
  if (cached !== null) return cached;
  const fromEnv = process.env.COMPANY_ID?.trim();
  const value = fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_SINGLETON_COMPANY_ID;
  if (!UUID_RE.test(value)) {
    throw new Error(
      `COMPANY_ID="${value}" is not a valid UUID. Set COMPANY_ID in apps/api/.env to a UUID, or unset it to use the default.`,
    );
  }
  cached = value;
  return cached;
}

export function resetSingletonCompanyIdForTests(): void {
  cached = null;
}
