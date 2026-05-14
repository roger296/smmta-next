/**
 * One-shot bootstrap for the Ralawise drop-ship supplier row.
 *
 * Reads `RALAWISE_USERNAME` and `RALAWISE_PASSWORD` from env, encrypts
 * them as a JSON blob `{user, password}` via the standard envelope
 * helper, then upserts a `suppliers` row with:
 *   - slug          = 'ralawise'
 *   - name          = 'Ralawise Limited'
 *   - connectorKind = 'RALAWISE'
 *   - apiBaseUrl    = 'https://api.ralawise.com/v1'
 *   - apiAuthScheme = 'bearer-with-login' (descriptive; the connector
 *                     handles the actual login flow internally — the
 *                     scheme string is metadata for the admin SPA)
 *   - isDropshipActive = true
 *   - pollIntervalMinutes = 180 (3 hours, in line with Uneek)
 *   - dispatchSlaMinDays = 1, dispatchSlaMaxDays = 3
 *
 * Idempotent: re-running with the same env updates the row in place
 * (refreshes the credentials envelope, keeps everything else).
 *
 * Usage:
 *
 *   RALAWISE_USERNAME=roger@example.com \
 *   RALAWISE_PASSWORD=hunter2 \
 *   DATABASE_URL=... \
 *   npx tsx apps/api/scripts/bootstrap-ralawise-supplier.ts
 *
 * Prints the supplier id on completion so it can be referenced by
 * later one-off scripts (catalogue seed, manual poll, etc).
 */
import 'dotenv/config';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { suppliers } from '../src/db/schema/index.js';
import { encrypt } from '../src/shared/crypto/encrypt.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';

const SLUG = 'ralawise';
const NAME = 'Ralawise Limited';
const API_BASE_URL = 'https://api.ralawise.com/v1';
const AUTH_SCHEME = 'bearer-with-login';

async function main(): Promise<void> {
  const user = process.env.RALAWISE_USERNAME?.trim();
  const password = process.env.RALAWISE_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'RALAWISE_USERNAME and RALAWISE_PASSWORD must both be set. ' +
        'Get credentials from ecommerce@ralawise.com.',
    );
  }

  const companyId = getSingletonCompanyId();
  const db = getDb();
  const credsJson = JSON.stringify({ user, password });
  const apiKeyEnc = encrypt(credsJson);

  const existing = await db.query.suppliers.findFirst({
    where: and(eq(suppliers.slug, SLUG), isNull(suppliers.deletedAt)),
  });

  if (existing) {
    await db
      .update(suppliers)
      .set({
        apiKeyEnc,
        apiBaseUrl: API_BASE_URL,
        apiAuthScheme: AUTH_SCHEME,
        connectorKind: 'RALAWISE',
        isDropshipActive: true,
        // Don't clobber operator-tuned values (poll interval, SLA, etc) — only
        // refresh the connection-side fields. Note: this also doesn't reset
        // `consecutiveFailures` or `lastError` so a half-stuck supplier doesn't
        // get accidentally re-activated on a re-bootstrap.
        // Set the rate-limit pair only when BOTH columns are NULL —
        // the operator may have tuned them from the admin SPA after
        // first bootstrap; respect that. We never touch
        // min_request_interval_ms (the explicit override) on re-runs.
        ...(existing.rateLimitRequests == null && existing.rateLimitWindowSeconds == null
          ? { rateLimitRequests: 10, rateLimitWindowSeconds: 60 }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(suppliers.id, existing.id));
    console.log(`[bootstrap] ralawise supplier already exists — refreshed credentials (id=${existing.id})`);
  } else {
    const [created] = await db
      .insert(suppliers)
      .values({
        companyId,
        name: NAME,
        slug: SLUG,
        connectorKind: 'RALAWISE',
        apiBaseUrl: API_BASE_URL,
        apiAuthScheme: AUTH_SCHEME,
        apiKeyEnc,
        isDropshipActive: true,
        pollIntervalMinutes: 180,
        dispatchSlaMinDays: 1,
        dispatchSlaMaxDays: 3,
        // Ralawise's documented rate limit is 10 requests per 60-second
        // window, per authenticated account, across all endpoints
        // (auth + inventory + order). The connector derives the
        // inter-request delay from this pair via
        // `deriveMinRequestIntervalMs` (6600 ms with the 10 % safety
        // margin). Operator can tune both numbers in the admin SPA
        // if Ralawise grant a higher limit.
        rateLimitRequests: 10,
        rateLimitWindowSeconds: 60,
        showSupplierNameToCustomers: false,
        countryCode: 'GB',
        currencyCode: 'GBP',
      })
      .returning({ id: suppliers.id });
    if (!created) throw new Error('Insert returned no row');
    console.log(`[bootstrap] created ralawise supplier (id=${created.id})`);
  }
  console.log('');
  console.log('Next steps:');
  console.log('  1. Run the polling worker to fetch initial stock counts:');
  console.log('     npx tsx apps/api/scripts/run-supplier-poll.ts');
  console.log('  2. Map products to Ralawise SKUs (admin SPA → Suppliers → Ralawise).');
  console.log('     OR run the bulk catalogue importer (§H) to import the full Ralawise catalogue.');
}

main()
  .catch((err) => {
    console.error('[bootstrap-ralawise-supplier] FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
