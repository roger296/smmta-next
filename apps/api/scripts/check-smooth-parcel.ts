/**
 * check-smooth-parcel.ts — prove the Smooth Parcel login works, buying nothing.
 *
 * Logs in with SMOOTH_PARCEL_USERNAME / SMOOTH_PARCEL_PASSWORD against
 * SMOOTH_PARCEL_API_BASE_URL, then makes one read-only call — a tracking lookup
 * for a number that does not exist — to confirm the API accepts the token, not
 * just the login page. It creates no shipment, and prints neither the password
 * nor the token.
 *
 * Run it inside the api container, so it sees the environment Coolify set:
 *   npx tsx apps/api/scripts/check-smooth-parcel.ts
 */
import { getEnv } from '../src/config/env.js';
import { SmoothParcelClient } from '../src/integrations/smooth-parcel/smooth-parcel-client.js';

async function main(): Promise<void> {
  const env = getEnv();
  console.log(`API:        ${env.SMOOTH_PARCEL_API_BASE_URL}`);
  console.log(`Username:   ${env.SMOOTH_PARCEL_USERNAME ? 'set' : 'NOT SET'}`);
  console.log(`Password:   ${env.SMOOTH_PARCEL_PASSWORD ? 'set' : 'NOT SET'}`);
  console.log(`Switched on: ${env.SMOOTH_PARCEL_ENABLED ? 'YES - paid orders will buy labels' : 'no - nothing is bought'}`);

  const { apiStatus } = await new SmoothParcelClient().checkConnection();
  console.log('Login:      OK');
  console.log(`API access: OK (test tracking lookup answered ${apiStatus})`);
}

main().catch((err: unknown) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
