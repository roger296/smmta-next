/**
 * Thin server-only Mollie API client.
 *
 * Uses fetch directly rather than `@mollie/api-client` so:
 *   - the bundle stays small,
 *   - tests can stub `globalThis.fetch` like the SMMTA client tests,
 *   - Idempotency-Key support is unambiguous (the Node SDK has been
 *     historically inconsistent about exposing it).
 *
 * Server-only — guarded by `import 'server-only'` to keep the API key
 * out of the client bundle.
 *
 * Mollie webhook handling lives in `app/api/mollie/webhook/route.ts`. The
 * client itself is just create + fetch; everything else (state machine,
 * SMMTA hand-off) happens in `lib/checkout.ts`.
 */
import 'server-only';
import { getEnv } from './env';

const MOLLIE_BASE = 'https://api.mollie.com/v2/';

export type MollieStatus =
  | 'open'
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'canceled'
  | 'expired'
  | 'failed'
  | 'refunded'
  | 'partially_refunded';

export interface MolliePayment {
  id: string;
  status: MollieStatus;
  amount: { value: string; currency: string };
  /** Method may be null until the customer picks one in hosted checkout. */
  method: string | null;
  description: string;
  metadata: Record<string, unknown> | null;
  redirectUrl: string | null;
  webhookUrl: string | null;
  /** _links.checkout.href — where the customer is redirected. */
  checkoutUrl: string | null;
}

export class MollieApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'MollieApiError';
    this.status = status;
    this.body = body;
  }
}

interface CreatePaymentInput {
  amount: { value: string; currency: string };
  description: string;
  redirectUrl: string;
  webhookUrl: string;
  metadata?: Record<string, unknown>;
  /** Idempotency-Key; we set it to checkoutId so retries can't duplicate. */
  idempotencyKey: string;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function ensureKey(): string {
  const key = getEnv().MOLLIE_API_KEY;
  if (!key) {
    throw new MollieApiError(
      'MOLLIE_API_KEY is not set — cannot talk to Mollie',
      0,
      undefined,
    );
  }
  return key;
}

/** Map Mollie's response shape to our compact type. Centralised so the
 *  webhook handler and the create-payment caller share one mapping. */
function toMolliePayment(raw: unknown): MolliePayment {
  const p = (raw ?? {}) as Record<string, unknown>;
  const amount = (p.amount ?? {}) as { value?: string; currency?: string };
  const links = (p._links ?? {}) as { checkout?: { href?: string } };
  return {
    id: String(p.id ?? ''),
    status: String(p.status ?? 'open') as MollieStatus,
    amount: { value: amount.value ?? '0.00', currency: amount.currency ?? 'GBP' },
    method: typeof p.method === 'string' ? p.method : null,
    description: String(p.description ?? ''),
    metadata: (p.metadata as Record<string, unknown> | null) ?? null,
    redirectUrl: typeof p.redirectUrl === 'string' ? p.redirectUrl : null,
    webhookUrl: typeof p.webhookUrl === 'string' ? p.webhookUrl : null,
    checkoutUrl: links.checkout?.href ?? null,
  };
}

/**
 * POST /v2/payments. Returns the freshly-created payment, including its
 * `checkoutUrl` (the URL we redirect the customer to).
 */
export async function createPayment(input: CreatePaymentInput): Promise<MolliePayment> {
  const key = ensureKey();
  const url = new URL('payments', MOLLIE_BASE);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({
      amount: input.amount,
      description: input.description,
      redirectUrl: input.redirectUrl,
      webhookUrl: input.webhookUrl,
      metadata: input.metadata,
    }),
    cache: 'no-store',
  });
  const raw = await safeJson(res);
  if (!res.ok) {
    throw new MollieApiError(
      `Mollie createPayment failed (${res.status})`,
      res.status,
      raw,
    );
  }
  return toMolliePayment(raw);
}

/**
 * GET /v2/payments/:id. Source of truth — the webhook handler always
 * re-fetches because Mollie's webhook body is just `id=...` and we never
 * trust unauthenticated bodies.
 */
export async function getPayment(id: string): Promise<MolliePayment> {
  const key = ensureKey();
  const url = new URL(`payments/${encodeURIComponent(id)}`, MOLLIE_BASE);
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  const raw = await safeJson(res);
  if (!res.ok) {
    throw new MollieApiError(
      `Mollie getPayment failed (${res.status})`,
      res.status,
      raw,
    );
  }
  return toMolliePayment(raw);
}

/** Mollie statuses that should commit the order. v1 treats `authorized`
 *  as paid because we don't enable manual capture. */
export function isCommitableStatus(status: MollieStatus): boolean {
  return status === 'paid' || status === 'authorized';
}

/** Mollie statuses where the reservation should be released. */
export function isTerminalNonPaid(status: MollieStatus): boolean {
  return status === 'canceled' || status === 'expired' || status === 'failed';
}

// ---------------------------------------------------------------------------
// Refunds (Prompt 12)
// ---------------------------------------------------------------------------

export interface MollieRefund {
  id: string;
  paymentId: string;
  status: string;
  amount: { value: string; currency: string };
  description: string | null;
}

interface CreateRefundInput {
  paymentId: string;
  amount: { value: string; currency: string };
  description?: string;
  /** Idempotency-Key — derive from credit-note id so a repeated
   *  operator click doesn't refund twice. */
  idempotencyKey: string;
}

function toMollieRefund(raw: unknown): MollieRefund {
  const r = (raw ?? {}) as Record<string, unknown>;
  const amount = (r.amount ?? {}) as { value?: string; currency?: string };
  return {
    id: String(r.id ?? ''),
    paymentId: String(r.paymentId ?? ''),
    status: String(r.status ?? ''),
    amount: { value: amount.value ?? '0.00', currency: amount.currency ?? 'GBP' },
    description: typeof r.description === 'string' ? r.description : null,
  };
}

/** POST /v2/payments/:id/refunds. */
export async function createRefund(input: CreateRefundInput): Promise<MollieRefund> {
  const key = ensureKey();
  const url = new URL(
    `payments/${encodeURIComponent(input.paymentId)}/refunds`,
    MOLLIE_BASE,
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({
      amount: input.amount,
      description: input.description,
    }),
    cache: 'no-store',
  });
  const raw = await safeJson(res);
  if (!res.ok) {
    throw new MollieApiError(
      `Mollie createRefund failed (${res.status})`,
      res.status,
      raw,
    );
  }
  return toMollieRefund(raw);
}

/** GET /v2/payments/:id/refunds — used by the webhook to refresh the
 *  local mollie_refunds rows after Mollie re-triggers the payment
 *  webhook for a refund event. */
export async function listRefunds(paymentId: string): Promise<MollieRefund[]> {
  const key = ensureKey();
  const url = new URL(
    `payments/${encodeURIComponent(paymentId)}/refunds`,
    MOLLIE_BASE,
  );
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  const raw = await safeJson(res);
  if (!res.ok) {
    throw new MollieApiError(
      `Mollie listRefunds failed (${res.status})`,
      res.status,
      raw,
    );
  }
  const embedded = (raw as { _embedded?: { refunds?: unknown[] } })?._embedded?.refunds;
  if (!Array.isArray(embedded)) return [];
  return embedded.map(toMollieRefund);
}
