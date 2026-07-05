/**
 * Verify the Mollie / OpenRouter / SendGrid keys in apps/api/.env authenticate,
 * using auth-only endpoints (no charges, no sends). Prints a per-provider
 * verdict; never echoes the key. Run: `npm run check:credentials -w @smmta/api`.
 */
import 'dotenv/config';
import { getEnv } from '../src/config/env.js';

const env = getEnv();

function line(name: string, ok: boolean, detail: string) {
  // eslint-disable-next-line no-console
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(11)} ${ok ? 'OK' : 'FAIL'} — ${detail}`);
  return ok;
}

async function checkMollie(): Promise<boolean> {
  if (!env.MOLLIE_API_KEY) return line('Mollie', false, 'MOLLIE_API_KEY not set');
  // Test/live mode is determined by the key prefix, not a query param.
  const res = await fetch('https://api.mollie.com/v2/methods', {
    headers: { Authorization: `Bearer ${env.MOLLIE_API_KEY}` },
  });
  const body = (await res.json().catch(() => ({}))) as { count?: number; detail?: string };
  const mode = env.MOLLIE_API_KEY.startsWith('test_') ? 'test' : 'LIVE';
  return line(
    'Mollie',
    res.ok,
    res.ok ? `${body.count ?? '?'} payment methods available (${mode} mode)` : `${res.status} ${body.detail ?? ''}`,
  );
}

async function checkOpenRouter(): Promise<boolean> {
  if (!env.OPENROUTER_API_KEY) return line('OpenRouter', false, 'OPENROUTER_API_KEY not set');
  const res = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { label?: string; usage?: number; limit?: number | null } };
  return line(
    'OpenRouter',
    res.ok,
    res.ok
      ? `key '${body.data?.label ?? 'ok'}', usage $${body.data?.usage ?? 0}${body.data?.limit != null ? ` / limit $${body.data.limit}` : ''}`
      : `${res.status}`,
  );
}

async function checkSendGrid(): Promise<boolean> {
  if (!env.SENDGRID_API_KEY) return line('SendGrid', false, 'SENDGRID_API_KEY not set');
  const res = await fetch('https://api.sendgrid.com/v3/scopes', {
    headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}` },
  });
  const body = (await res.json().catch(() => ({}))) as { scopes?: string[]; errors?: Array<{ message: string }> };
  return line(
    'SendGrid',
    res.ok,
    res.ok ? `${body.scopes?.length ?? 0} scopes granted` : `${res.status} ${body.errors?.[0]?.message ?? ''}`,
  );
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Checking provider credentials (auth-only calls; no charges/sends)…\n');
  const results = await Promise.all([checkMollie(), checkOpenRouter(), checkSendGrid()]);
  const allOk = results.every(Boolean);
  // eslint-disable-next-line no-console
  console.log(`\n${allOk ? 'All credentials verified.' : 'Some credentials failed — see above.'}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('check-credentials error', err);
  process.exit(1);
});
