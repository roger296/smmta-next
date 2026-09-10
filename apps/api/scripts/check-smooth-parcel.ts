/**
 * check-smooth-parcel.ts — prove the Smooth Parcel login works, buying nothing.
 *
 * Logs in with SMOOTH_PARCEL_USERNAME / SMOOTH_PARCEL_PASSWORD against
 * SMOOTH_PARCEL_API_BASE_URL, then makes one read-only call — a tracking lookup
 * for a number that does not exist — to confirm the API accepts the token, not
 * just the login page. It creates no shipment.
 *
 * If that fails, it prints diagnostics, all from read-only calls: the NAMES of
 * the fields in the login reply, the names of the claims in the token, and how
 * a few endpoints answer that token. It never prints the password, the token,
 * or any field value from the login reply except its status and message.
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
  console.log(`Username:   ${env.SMOOTH_PARCEL_USERNAME ? 'set' : 'NOT SET'}`);
  console.log(`Password:   ${env.SMOOTH_PARCEL_PASSWORD ? 'set' : 'NOT SET'}`);
  console.log(`Switched on: ${env.SMOOTH_PARCEL_ENABLED ? 'YES - paid orders will buy labels' : 'no - nothing is bought'}`);

  try {
    const { apiStatus } = await new SmoothParcelClient().checkConnection();
    console.log('Login:      OK');
    console.log(`API access: OK (test tracking lookup answered ${apiStatus})`);
  } catch (err) {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    if (env.SMOOTH_PARCEL_USERNAME && env.SMOOTH_PARCEL_PASSWORD) {
      await diagnose(env.SMOOTH_PARCEL_API_BASE_URL.replace(/\/+$/, ''), env.SMOOTH_PARCEL_USERNAME.trim(), env.SMOOTH_PARCEL_PASSWORD);
    }
    // exitCode, not exit(): exiting with fetch sockets still open crashes Node on Windows.
    process.exitCode = 1;
  }
}

async function diagnose(base: string, username: string, password: string): Promise<void> {
  console.log('\n--- Diagnostics (read-only; no password or token is shown) ---');
  const login = await call('POST', `${base}/api/users/authenticate`, { EmailAddress: username, password });
  const reply = parse(login.text);
  console.log(`Login reply: HTTP ${login.status}, fields: ${reply && typeof reply === 'object' ? Object.keys(reply).join(', ') : typeof reply}`);
  if (!reply || typeof reply !== 'object') return;
  const r = reply as Record<string, unknown>;
  if ('status' in r) console.log(`  status: ${JSON.stringify(r.status)}`);
  if (typeof r.message === 'string' && !r.message.includes(password)) console.log(`  message: ${r.message.slice(0, 200)}`);

  const token = typeof r.token === 'string' ? r.token : '';
  if (!token) {
    console.log('  no token in the reply');
    return;
  }
  const parts = token.split('.');
  console.log(`Token: ${parts.length === 3 ? 'a JWT' : `not a JWT (${parts.length} parts)`}, ${token.length} characters`);
  if (parts.length === 3) {
    const claims = parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (claims && typeof claims === 'object') {
      const c = claims as Record<string, unknown>;
      console.log(`  claim names: ${Object.keys(c).join(', ')}`);
      if (typeof c.exp === 'number') console.log(`  expires: ${new Date(c.exp * 1000).toISOString()}`);
      for (const [k, v] of Object.entries(c)) {
        if (/role|level|type|api|scope|perm/i.test(k)) console.log(`  ${k}: ${JSON.stringify(v).slice(0, 120)}`);
      }
    }
  }

  const bearer = { Authorization: `Bearer ${token}` };
  const probes: Array<{ label: string; method: 'GET' | 'POST'; path: string; body?: unknown; headers: Record<string, string>; showBody: boolean }> = [
    { label: 'Portal: countries list', method: 'GET', path: '/api/Shipment/GetCountries', headers: bearer, showBody: false },
    { label: 'Portal: account balance', method: 'GET', path: '/api/myaccount/GetBalance', headers: bearer, showBody: false },
    { label: 'API: tracking (Bearer)', method: 'POST', path: '/api/APIAccess/Tracking', body: { SmoothParcelTrackingNumber: 'CONNECTION-CHECK' }, headers: bearer, showBody: true },
    { label: 'API: tracking (token without Bearer)', method: 'POST', path: '/api/APIAccess/Tracking', body: { SmoothParcelTrackingNumber: 'CONNECTION-CHECK' }, headers: { Authorization: token }, showBody: true },
    { label: 'API: label for order 0 (Bearer)', method: 'POST', path: '/api/APIAccess/GetShipmentLabel', body: { OrderCode: 0 }, headers: bearer, showBody: true },
  ];
  for (const p of probes) {
    const res = await call(p.method, `${base}${p.path}`, p.body, p.headers);
    const extra = p.showBody && res.text ? ` — ${res.text.replaceAll(token, '<token>').slice(0, 200)}` : '';
    const challenge = res.challenge ? ` [WWW-Authenticate: ${res.challenge}]` : '';
    console.log(`${p.label}: HTTP ${res.status}${challenge}${extra}`);
  }
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; challenge: string | null }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text().catch(() => ''), challenge: res.headers.get('www-authenticate') };
  } catch (err) {
    return { status: 0, text: err instanceof Error ? err.message : String(err), challenge: null };
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
