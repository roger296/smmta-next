/**
 * Write a product's expected cost back from the venue screen (C-5).
 *
 * "Request to add base-unit increment buttons…" was C-6; this is the other
 * half the tester could not reach: the "Set £" sheet could adjust the cost on
 * the *line*, but nothing carried it back to the product, so the next delivery
 * defaulted to £0.00 again.
 *
 * Server-side this is `site_manager`+ (E-4) — a cost moves money — and the 403
 * surfaces through the goods-in error banner.
 */
import { apiFetch } from '@/lib/api-client';
import type { Product } from '@/lib/api-types';

export function updateExpectedCost(productId: string, expectedNextCost: number): Promise<Product> {
  return apiFetch<Product>(`/products/${productId}`, {
    method: 'PUT',
    body: { expectedNextCost },
  });
}
