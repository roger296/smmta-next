/**
 * Barcode / QR helpers for the iPad PWA (P12, spec §A1).
 *
 * Scanning uses the device camera via the native BarcodeDetector API where
 * available; resolving a scanned code to a product goes through an injectable
 * lookup (the real impl queries the products API; tests inject a mock).
 */
import { apiFetch } from './api-client';
import type { Product } from './api-types';

export function isBarcodeScanSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

/** Default lookup — search products by the scanned code. */
export function productBarcodeLookup(code: string): Promise<Product[]> {
  return apiFetch<Product[]>('/products', { searchParams: { search: code } }).then((r) =>
    Array.isArray(r) ? r : ((r as unknown as { data?: Product[] }).data ?? []),
  );
}

/**
 * Resolve a scanned barcode to a single product. Prefers an exact barcode/ean
 * match; falls back to the first candidate. Returns null if nothing matches.
 */
export async function resolveBarcodeToProduct(
  code: string,
  lookup: (code: string) => Promise<Product[]> = productBarcodeLookup,
): Promise<Product | null> {
  const candidates = await lookup(code);
  return (
    candidates.find((p) => p.barcode === code || p.ean === code) ?? candidates[0] ?? null
  );
}
