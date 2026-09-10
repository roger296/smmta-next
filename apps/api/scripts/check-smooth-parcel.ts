/**
 * check-smooth-parcel.ts — prove the Smooth Parcel connection works, buying nothing.
 *
 * Sends SMOOTH_PARCEL_API_KEY to SMOOTH_PARCEL_API_BASE_URL on one read-only
 * call (a tracking lookup for a number that does not exist), to confirm the
 * label API accepts the key. It creates no shipment.
 *
 * If that fails, it prints diagnostics, all from read-only calls: how the API
 * answers the key with and without "Bearer", and, when a username and password
 * are set, whether that login works and which fields it returns (names only).
 * It never prints the key, the password or a token.
 *
 * Run it inside the api container, so it sees the environment Coolify set:
 *   npx tsx apps/api/scripts/check-smooth-parcel.ts
 */
import { getEnv } from '../src/config/env.js';
import { SmoothParcelClient } from '../src/integrations/smooth-parcel/smooth-parcel-client.js';

const TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const env = getEnv();
  console.log(`API:        ${env.SMOOTH_PARCEL_API_BASE_URL}`);
  console.log(`API key:    ${env.SMOOTH_PARCEL_API_KEY ? 'set' : 'NOT SET'}`);
  console.log(`Username:   ${env.SMOOTH_PARCEL_USERNAME ? 'set' : 'NOT SET'}`);
  console.log(`Password:   ${env.SMOOTH_PARCEL_PASSWORD ? 'set' : 'NOT SET'}`);
  console.log(`Switched on: ${env.SMOOTH_PARCEL_ENABLED ? 'YES - paid orders will buy labels' : 'no - nothing is bought'}`);

  try {
    const { apiStatus } = await new SmoothParcelClient().checkConnection();
    console.log(`API access: OK (test tracking lookup answered ${apiStatus})`);
  } catch (err) {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    await diagnose(env.SMOOTH_PARCEL_API_BASE_URL.replace(/\/+$/, ''), {
      apiKey: env.SMOOTH_PARCEL_API_KEY,
      username: env.SMOOTH_PARCEL_USERNAME.trim(),
      password: env.SMOOTH_PARCEL_PASSWORD,
    });
    // exitCode, not exit(): exiting with fetch sockets still open crashes Node on Windows.
    process.exitCode = 1;
  }
}

async function diagnose(base: string, creds: { apiKey: string; username: string; password: string }): Promise<void> {
  console.log('\n--- Diagnostics (read-only; no key, password or token is shown) ---');
  const secrets = [creds.apiKey, creds.password].filter(Boolean);
  const mask = (text: string) => secrets.reduce((t, s) => t.replaceAll(s, '<hidden>'), text);
  const tracking = { SmoothParcelTrackingNumber: 'CONNECTION-CHECK' };

  if (creds.apiKey) {
    for (const [label, header] of [
      ['API: tracking (key as Authorization)', creds.apiKey],
      ['API: tracking (key with Bearer)', `Bearer ${creds.apiKey}`],
    ] as const) {
      const res = await call('POST', `${base}/api/APIAccess/Tracking`, tracking, { Authorization: header });
      console.log(`${label}: HTTP ${res.status}${res.text ? ` — ${mask(res.text).slice(0, 200)}` : ''}`);
    }
  }

  if (creds.username && creds.password) {
    const login = await call('POST', `${base}/api/users/authenticate`, { EmailAddress: creds.username, password: creds.password });
    const reply = parse(login.text);
    const r = reply && typeof reply === 'object' ? (reply as Record<string, unknown>) : null;
    console.log(`Login: HTTP ${login.status}, fields: ${r ? Object.keys(r).join(', ') : typeof reply}`);
    if (r && 'status' in r) console.log(`  status: ${JSON.stringify(r.status)}`);
    if (r && typeof r.message === 'string') console.log(`  message: ${mask(r.message).slice(0, 200)}`);
  }
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text().catch(() => '') };
  } catch (err) {
    return { status: 0, text: err instanceof Error ? err.message : String(err) };
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

main().catch((err: unknown) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
