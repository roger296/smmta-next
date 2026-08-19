/**
 * Barcode / QR helpers for the iPad PWA (P12, spec §A1).
 *
 * Scanning uses the device camera via the native BarcodeDetector API where
 * available; resolving a scanned code to a product goes through an injectable
 * lookup (the real impl queries the products API; tests inject a mock).
 *
 * ── Defect C-3 ──────────────────────────────────────────────────────────────
 *
 * "Manual barcode entry failed to find the product for an icing sugar
 * delivery." Two causes, both fixed here and in `product.service.ts`:
 *
 *  1. the server's search predicate covered `name`, `stockCode` and `ean` but
 *     **not `barcode`**, despite the column and its scan-to-find index
 *     existing;
 *  2. this resolver preferred an exact match *among whatever the search
 *     endpoint happened to return* — a relevance-ordered page, which for a
 *     numeric code can easily not contain the right product at all.
 *
 * A scan now asks a question with one answer: `GET /products/by-code/:code`.
 * Search stays as the fallback, for a code the exact endpoint does not know
 * but that appears inside some field.
 */
import { ApiError, apiFetch } from './api-client';
import type { Product } from './api-types';

export function isBarcodeScanSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

/** Search products by any code or name fragment. */
export function productBarcodeLookup(code: string): Promise<Product[]> {
  return apiFetch<Product[]>('/products', { searchParams: { search: code } }).then((r) =>
    Array.isArray(r) ? r : ((r as unknown as { data?: Product[] }).data ?? []),
  );
}

/** Exact single-product resolution. `null` when nothing carries the code. */
export async function productExactLookup(code: string): Promise<Product | null> {
  try {
    return await apiFetch<Product>(`/products/by-code/${encodeURIComponent(code)}`);
  } catch (err) {
    // A 404 is the honest answer "nothing carries this code" — not a failure.
    // Anything else (offline, 500, a bad token) must propagate, so the screen
    // can say "could not look that up" rather than "no such product", which
    // are very different things to a baker holding a delivery note.
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Resolve a scanned or typed code to a single product.
 *
 * Exact match first, always. Only if the exact endpoint knows nothing do we
 * fall back to search — and even then an exact `barcode`/`ean`/`stockCode`
 * match among the candidates outranks a name relevance hit, because a code
 * that appears inside a product NAME is a coincidence, not an identification.
 */
export async function resolveBarcodeToProduct(
  code: string,
  lookup: (code: string) => Promise<Product[]> = productBarcodeLookup,
  exact: (code: string) => Promise<Product | null> = productExactLookup,
): Promise<Product | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;

  const direct = await exact(trimmed);
  if (direct) return direct;

  const candidates = await lookup(trimmed);
  const equalsCode = (value: string | null | undefined) =>
    !!value && value.toLowerCase() === trimmed.toLowerCase();

  return (
    candidates.find((p) => equalsCode(p.barcode) || equalsCode(p.ean) || equalsCode(p.stockCode)) ??
    candidates[0] ??
    null
  );
}

/** Attach a scanned code to a product so the next delivery scans first time. */
export function attachBarcodeToProduct(productId: string, barcode: string): Promise<Product> {
  return apiFetch<Product>(`/products/${productId}/barcode`, {
    method: 'POST',
    body: { barcode },
  });
}
