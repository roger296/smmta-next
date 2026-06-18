/**
 * Barcode resolution (P12). The scanner resolves a known barcode to a product
 * (lookup mocked).
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveBarcodeToProduct } from './barcode';
import type { Product } from './api-types';

const p = (over: Partial<Product>): Product => ({ id: 'x', name: 'X', barcode: null, ean: null, ...over } as unknown as Product);

describe('resolveBarcodeToProduct', () => {
  it('resolves a scanned barcode to the matching product', async () => {
    const lookup = vi.fn(async (code: string) => [
      p({ id: 'p2', name: 'Other', barcode: '999' }),
      p({ id: 'p1', name: 'Cookie', barcode: code }),
    ]);
    const product = await resolveBarcodeToProduct('5060000000001', lookup);
    expect(lookup).toHaveBeenCalledWith('5060000000001');
    expect(product?.id).toBe('p1');
  });

  it('falls back to an ean match', async () => {
    const lookup = vi.fn(async (code: string) => [p({ id: 'p3', name: 'Flour', ean: code })]);
    const product = await resolveBarcodeToProduct('5012345678900', lookup);
    expect(product?.id).toBe('p3');
  });

  it('returns null when nothing matches and there are no candidates', async () => {
    const lookup = vi.fn(async () => []);
    const product = await resolveBarcodeToProduct('0000', lookup);
    expect(product).toBeNull();
  });
});
