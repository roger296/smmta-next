/**
 * Barcode resolution (P12; rewritten for the Aug-2026 feedback set, C-3).
 *
 * "Manual barcode entry failed to find the product for an icing sugar
 * delivery." A scan is a question with one answer, so resolution now asks the
 * exact endpoint first and only falls back to search — and even in the
 * fallback, an exact code match outranks a name relevance hit.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-client';
import { resolveBarcodeToProduct } from './barcode';
import type { Product } from './api-types';

const p = (over: Partial<Product>): Product =>
  ({ id: 'x', name: 'X', barcode: null, ean: null, stockCode: null, ...over }) as unknown as Product;

/** No product carries the code — what the real endpoint returns on a 404. */
const noExact = async () => null;

describe('resolveBarcodeToProduct', () => {
  it('C-3: asks the exact endpoint first and does not search at all when it answers', async () => {
    const lookup = vi.fn(async () => []);
    const exact = vi.fn(async () => p({ id: 'p1', name: 'Icing sugar', barcode: '5012345678900' }));

    const product = await resolveBarcodeToProduct('5012345678900', lookup, exact);

    expect(product?.id).toBe('p1');
    expect(exact).toHaveBeenCalledWith('5012345678900');
    // A relevance-ordered page is not needed, and asking for one from a venue
    // iPad on bad wifi is a request that can only lose.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('resolves a scanned barcode from the search fallback', async () => {
    const lookup = vi.fn(async (code: string) => [
      p({ id: 'p2', name: 'Other', barcode: '999' }),
      p({ id: 'p1', name: 'Cookie', barcode: code }),
    ]);
    const product = await resolveBarcodeToProduct('5060000000001', lookup, noExact);
    expect(lookup).toHaveBeenCalledWith('5060000000001');
    expect(product?.id).toBe('p1');
  });

  it('falls back to an ean match', async () => {
    const lookup = vi.fn(async (code: string) => [p({ id: 'p3', name: 'Flour', ean: code })]);
    const product = await resolveBarcodeToProduct('5012345678900', lookup, noExact);
    expect(product?.id).toBe('p3');
  });

  it('matches a stock code typed off a shelf label', async () => {
    const lookup = vi.fn(async () => [
      p({ id: 'p9', name: 'Something else' }),
      p({ id: 'p4', name: 'Icing sugar', stockCode: 'ING-ICING' }),
    ]);
    const product = await resolveBarcodeToProduct('ing-icing', lookup, noExact);
    expect(product?.id).toBe('p4');
  });

  it('C-3: an exact code match outranks the first candidate', async () => {
    // The failure mode this guards: the search returns a name-relevance page
    // whose FIRST row merely mentions the digits, and the real product is
    // further down. Taking candidates[0] books the delivery against the wrong
    // item — silently.
    const lookup = vi.fn(async () => [
      p({ id: 'wrong', name: 'Sugar sachets 5012345678900 case' }),
      p({ id: 'right', name: 'Icing sugar', barcode: '5012345678900' }),
    ]);
    const product = await resolveBarcodeToProduct('5012345678900', lookup, noExact);
    expect(product?.id).toBe('right');
  });

  it('returns null when nothing matches and there are no candidates', async () => {
    const lookup = vi.fn(async () => []);
    const product = await resolveBarcodeToProduct('0000', lookup, noExact);
    expect(product).toBeNull();
  });

  it('returns null for an empty code without asking anything', async () => {
    const lookup = vi.fn(async () => []);
    const exact = vi.fn(async () => null);
    expect(await resolveBarcodeToProduct('   ', lookup, exact)).toBeNull();
    expect(exact).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('propagates a real failure rather than reporting "no such product"', async () => {
    // "Could not look that up" and "no product carries that code" are very
    // different things to a baker holding a delivery note.
    const exact = vi.fn(async () => {
      throw new ApiError('Service Unavailable', 503);
    });
    await expect(resolveBarcodeToProduct('5012345678900', async () => [], exact)).rejects.toThrow(
      /Service Unavailable/,
    );
  });
});
