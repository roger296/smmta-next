/**
 * Typed server-side client for the SMMTA-NEXT storefront read surface
 * (Prompt 4 endpoints).
 *
 * Retries 5xx and network errors up to 3 times with jittered exponential
 * back-off. Any 4xx or terminal failure throws `SmmtaApiError` carrying the
 * status and parsed body so route handlers can branch on `notFound()` vs.
 * a 5xx page.
 *
 * Server-only — guarded by `import 'server-only'` to keep the api key out
 * of the client bundle.
 */
import 'server-only';
import { getEnv } from './env';
import type {
  ApiEnvelope,
  FullGroup,
  FullProduct,
  GroupListItem,
} from './api-types';

export class SmmtaApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'SmmtaApiError';
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  /** Next.js fetch revalidate window in seconds. Defaults to 60. Pass `false`
   *  to opt out of caching entirely. */
  revalidate?: number | false;
  /** Tags for fine-grained `revalidateTag` invalidation. */
  tags?: string[];
  signal?: AbortSignal;
}

const DEFAULT_RETRIES = 3;
/** Base back-off in ms. Final delay = uniform(0, base * 2^attempt + base). */
const BASE_BACKOFF_MS = 200;

function isRetriable(status: number): boolean {
  return status >= 500 && status <= 599;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, baseMs = BASE_BACKOFF_MS): number {
  const exp = baseMs * 2 ** attempt;
  return Math.floor(Math.random() * (exp + baseMs));
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

/** Internal fetch with retries. Exposed for testing only — page code uses the
 *  typed entry points below. */
export async function smmtaFetch<T>(
  path: string,
  options: RequestOptions = {},
  retries = DEFAULT_RETRIES,
): Promise<T> {
  const env = getEnv();
  const url = new URL(
    path.startsWith('/') ? path.slice(1) : path,
    ensureTrailingSlash(env.SMMTA_API_BASE_URL),
  );

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (env.SMMTA_API_KEY) headers.Authorization = `Bearer ${env.SMMTA_API_KEY}`;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: options.signal,
        next:
          options.revalidate === false
            ? { revalidate: false, tags: options.tags }
            : { revalidate: options.revalidate ?? 60, tags: options.tags },
      });

      if (res.ok) {
        const envelope = (await res.json()) as ApiEnvelope<T>;
        if (!envelope.success) {
          throw new SmmtaApiError(
            envelope.error ?? `Request to ${path} failed`,
            res.status,
            envelope,
          );
        }
        return envelope.data as T;
      }

      const body = await safeJson(res);
      if (isRetriable(res.status) && attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new SmmtaApiError(
        typeof body === 'object' && body && 'error' in body && typeof body.error === 'string'
          ? body.error
          : `Request to ${path} failed with ${res.status}`,
        res.status,
        body,
      );
    } catch (err) {
      lastError = err;
      // SmmtaApiError from a 4xx is terminal — we already decided not to retry.
      if (err instanceof SmmtaApiError) throw err;
      if (attempt >= retries) break;
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError instanceof Error
    ? new SmmtaApiError(lastError.message, 0, undefined)
    : new SmmtaApiError(`Request to ${path} failed`, 0, undefined);
}

// ---------------------------------------------------------------------------
// Public typed API — used by the page components.
// ---------------------------------------------------------------------------

/** GET /storefront/groups — published groups + thin variants. */
export function listGroups(opts?: RequestOptions): Promise<GroupListItem[]> {
  return smmtaFetch<GroupListItem[]>('storefront/groups', {
    revalidate: 60,
    tags: ['storefront:groups'],
    ...opts,
  });
}

/** GET /storefront/groups/:slug — full group with full variants. */
export function getGroupBySlug(
  slug: string,
  opts?: RequestOptions,
): Promise<FullGroup> {
  return smmtaFetch<FullGroup>(`storefront/groups/${encodeURIComponent(slug)}`, {
    revalidate: 60,
    tags: [`storefront:group:${slug}`],
    ...opts,
  });
}

/** GET /storefront/products/:slug — single product (works for grouped variants too). */
export function getProductBySlug(
  slug: string,
  opts?: RequestOptions,
): Promise<FullProduct> {
  return smmtaFetch<FullProduct>(`storefront/products/${encodeURIComponent(slug)}`, {
    revalidate: 60,
    tags: [`storefront:product:${slug}`],
    ...opts,
  });
}

/** GET /storefront/products?ids=<csv> — batch lookup for cart price snapshots. */
export function getProductsByIds(
  ids: string[],
  opts?: RequestOptions,
): Promise<FullProduct[]> {
  if (ids.length === 0) return Promise.resolve([]);
  const params = new URLSearchParams({ ids: ids.join(',') });
  return smmtaFetch<FullProduct[]>(`storefront/products?${params.toString()}`, {
    // Cart price snapshots must always reflect live availability.
    revalidate: false,
    ...opts,
  });
}

/**
 * Cheap reachability probe used by /healthz. A 4xx is still "reachable"
 * from the storefront's perspective; only network failures and 5xx count
 * as down.
 */
export async function ping(timeoutMs = 2_000): Promise<{ ok: boolean; status: number }> {
  const env = getEnv();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = new URL(
      'storefront/products',
      ensureTrailingSlash(env.SMMTA_API_BASE_URL),
    );
    url.searchParams.set('ids', '00000000-0000-4000-8000-000000000000');
    const res = await fetch(url, {
      headers: env.SMMTA_API_KEY ? { Authorization: `Bearer ${env.SMMTA_API_KEY}` } : {},
      signal: ctrl.signal,
      cache: 'no-store',
    });
    return { ok: res.status < 500, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(t);
  }
}
