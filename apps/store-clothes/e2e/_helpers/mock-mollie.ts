/**
 * Network-level Mollie mock for Playwright E2E.
 *
 * The storefront (Next.js / Node fetch) talks to Mollie at
 * api.mollie.com. In CI we don't want to depend on that, and we
 * definitely don't want to drive Mollie's hosted-checkout UI from
 * Playwright (Mollie doesn't promise UI stability). Instead, we
 * intercept the storefront's outbound traffic at the test runner
 * level using a small Express-ish HTTP server bound on a free port,
 * point `MOLLIE_API_KEY` / the storefront's Mollie base URL at it,
 * and respond with whatever the test wants.
 *
 * The base URL the storefront uses lives at module load time in
 * `apps/store/lib/mollie.ts` as `https://api.mollie.com/v2/`. We
 * can't redirect outbound traffic from inside a Playwright test, so
 * the suite needs the *server-side* env to point at us before boot.
 * The CI workflow handles this via `MOLLIE_API_BASE_URL` (set by the
 * workflow) — see `apps/store/lib/mollie.ts` for the matching
 * adjustment in this prompt.
 *
 * For sad-path tests, `setMollieScenario(name)` lets the test
 * choose what state the next created payment should report when
 * fetched (paid / cancelled / etc.).
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

export type MollieScenario =
  /** payment is open at create + paid at the second getPayment poll */
  | 'paid'
  /** payment cancelled — drives the FAILED checkout path */
  | 'cancelled'
  /** payment paid, but the storefront's webhook is rejected (500) so
   *  the return page's polling fallback has to commit. */
  | 'webhook-fails';

interface PaymentRecord {
  id: string;
  status: 'open' | 'paid' | 'canceled';
  amount: { value: string; currency: string };
  redirectUrl: string;
  webhookUrl: string;
  metadata: Record<string, unknown>;
}

let server: http.Server | null = null;
let scenario: MollieScenario = 'paid';
const payments = new Map<string, PaymentRecord>();
let nextPaymentId = 1;

export function setMollieScenario(s: MollieScenario): void {
  scenario = s;
}

export async function startMockMollie(port?: number): Promise<{ url: string }> {
  if (server) throw new Error('Mock Mollie is already running');
  // Default port: read MOCK_MOLLIE_PORT (set by the CI workflow so the
  // storefront's MOLLIE_API_BASE_URL aligns); fall back to 0 (random)
  // for local runs where the operator can rebind freely.
  const resolvedPort = port ?? Number(process.env.MOCK_MOLLIE_PORT ?? '0');
  server = http.createServer(handle);
  await new Promise<void>((resolve) =>
    server!.listen(resolvedPort, '127.0.0.1', resolve),
  );
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No mock Mollie port');
  return { url: `http://127.0.0.1:${addr.port}/v2/` };
}

export async function stopMockMollie(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server!.close((err) => (err ? reject(err) : resolve())),
  );
  server = null;
  payments.clear();
  nextPaymentId = 1;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // POST /v2/payments — create
  if (method === 'POST' && url === '/v2/payments') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as {
        amount: { value: string; currency: string };
        redirectUrl: string;
        webhookUrl: string;
        metadata?: Record<string, unknown>;
      };
      const id = `tr_mock_${nextPaymentId++}`;
      const record: PaymentRecord = {
        id,
        status: 'open',
        amount: parsed.amount,
        redirectUrl: parsed.redirectUrl,
        webhookUrl: parsed.webhookUrl,
        metadata: parsed.metadata ?? {},
      };
      payments.set(id, record);
      // Mollie's _links.checkout.href is what we redirect the customer
      // to in production. Mocked: we point straight back at the
      // storefront's redirectUrl (`/checkout/return?cid=…`), simulating
      // a Mollie payment that completed instantly. The return page's
      // polling then fetches `getPayment` against this mock, which
      // reports the scenario-driven status.
      const checkoutUrl = record.redirectUrl;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...record,
          method: null,
          description: 'mock',
          _links: { checkout: { href: checkoutUrl } },
        }),
      );
    });
    return;
  }

  // GET /v2/payments/:id — read
  const m = /^\/v2\/payments\/(tr_mock_\d+)$/.exec(url);
  if (method === 'GET' && m) {
    const id = m[1]!;
    const record = payments.get(id);
    if (!record) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 404, title: 'Not Found' }));
      return;
    }
    // Apply scenario state on the get — `paid` and `cancelled` flip
    // the status when the storefront re-reads. `webhook-fails` keeps
    // it `paid` here (the webhook handler is what fails — see helper).
    if (scenario === 'paid' || scenario === 'webhook-fails') {
      record.status = 'paid';
    } else if (scenario === 'cancelled') {
      // Mollie's canonical spelling is the American "canceled" (one L).
      // The storefront's `isTerminalNonPaid()` and the `MollieStatus` type
      // both match that spelling — emitting British "cancelled" here
      // means the cancelled-path is silently never taken.
      record.status = 'canceled';
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ...record,
        method: 'creditcard',
        description: 'mock',
        _links: {},
      }),
    );
    return;
  }

  // POST /v2/payments/:id/refunds — used by the admin flow if any
  // e2e tests exercise refunds. Stubbed to "pending".
  const r = /^\/v2\/payments\/(tr_mock_\d+)\/refunds$/.exec(url);
  if (method === 'POST' && r) {
    const id = r[1]!;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { amount: { value: string; currency: string } };
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `re_mock_${id}`,
          paymentId: id,
          status: 'pending',
          amount: parsed.amount,
          description: null,
        }),
      );
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 404, title: 'Not Found', url }));
}

/**
 * Returns the id of the most recently created mock payment. Used by tests
 * that need to fire a webhook for "the payment this test just created" —
 * hardcoding `tr_mock_1` is unsafe because the in-memory counter doesn't
 * reliably reset between Playwright workers, and even when it does, the
 * order of tests in the worker affects which id the storefront gets.
 */
export function lastMockPaymentId(): string {
  if (nextPaymentId <= 1) {
    throw new Error('lastMockPaymentId(): no mock payments created yet');
  }
  return `tr_mock_${nextPaymentId - 1}`;
}

/** Trigger the storefront's webhook handler from the test, which is
 *  what Mollie would do in production. */
export async function fireWebhook(
  baseUrl: string,
  paymentId: string,
): Promise<{ status: number }> {
  const res = await fetch(`${baseUrl}/api/mollie/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `id=${encodeURIComponent(paymentId)}`,
  });
  return { status: res.status };
}
