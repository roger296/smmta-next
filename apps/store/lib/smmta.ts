/**
 * Thin server-only client for the SMMTA-NEXT API.
 *
 * Prompt 7 only needs a minimal `ping()` for the healthz endpoint. The
 * full typed catalogue + reservation client lands in Prompt 8. This file
 * exists now so future prompts can extend it without churning the import
 * surface.
 */
import 'server-only';
import { getEnv } from './env';

export class SmmtaApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SmmtaApiError';
    this.status = status;
  }
}

/**
 * Cheap reachability check used by /healthz. Hits a known-good
 * storefront read endpoint with an empty `ids` query — we only care
 * that the API responds within the timeout. A 4xx response is still
 * "reachable" from the storefront's perspective; only network errors
 * and 5xx fail the health check.
 */
export async function ping(timeoutMs = 2_000): Promise<{ ok: boolean; status: number }> {
  const env = getEnv();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = new URL('storefront/products', ensureTrailingSlash(env.SMMTA_API_BASE_URL));
    url.searchParams.set('ids', '00000000-0000-4000-8000-000000000000');
    const res = await fetch(url, {
      method: 'GET',
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

function ensureTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}
