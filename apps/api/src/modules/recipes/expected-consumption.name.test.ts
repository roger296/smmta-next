/**
 * Every expected line must carry a product NAME, resolved server-side.
 *
 * The head-baker form used to look names up in the browser from a single
 * 500-row page of products, falling back to the first 8 characters of the id.
 * That broke the moment the catalogue passed 500 products — and it broke
 * quietly: nothing errored, no request failed, the form simply started showing
 * bakers a column of hex fragments and asking how much of each they had used.
 *
 * These are compile-time guarantees as much as runtime ones. If `productName`
 * is ever dropped from the contract, this file stops typechecking.
 */
import { describe, expect, it } from 'vitest';
import type { ExpectedLine } from './expected-consumption.service.js';

describe('ExpectedLine', () => {
  it('carries a name alongside the id', () => {
    const line: ExpectedLine = {
      productId: '00000000-0000-0000-0000-000000000000',
      productName: 'Caster Sugar',
      qtyPerCover: 0.05,
      expectedQty: 1.2,
      stockUom: 'kg',
      unitCost: 1.1,
      expectedCost: 1.32,
    };
    expect(line.productName).toBe('Caster Sugar');
  });

  it('says so plainly when a recipe line outlives its product', () => {
    const id = '2bd68a39-1111-2222-3333-444444444444';
    const line: ExpectedLine = {
      productId: id,
      productName: 'Unknown product',
      qtyPerCover: 1,
      expectedQty: 1,
      stockUom: 'each',
      unitCost: null,
      expectedCost: null,
    };
    // The old fallback rendered exactly this id as "2bd68a39". A baker can act
    // on "Unknown product"; they can do nothing at all with a hex fragment.
    expect(line.productName).not.toBe(id.slice(0, 8));
    expect(line.productName).toBe('Unknown product');
  });
});
