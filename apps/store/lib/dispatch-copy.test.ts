import { describe, expect, it } from 'vitest';
import { DISPATCH_COPY, effectiveStockState, isSellable } from './dispatch-copy';

describe('DISPATCH_COPY', () => {
  it('has copy for every state', () => {
    expect(DISPATCH_COPY.IN_STOCK.badgeLabel).toBe('In stock');
    expect(DISPATCH_COPY.AVAILABLE_FROM_SUPPLIER.badgeLabel).toBe('Available from supplier');
    expect(DISPATCH_COPY.OUT_OF_STOCK.badgeLabel).toBe('Out of stock');

    expect(DISPATCH_COPY.IN_STOCK.primary).toMatch(/1 working day/);
    expect(DISPATCH_COPY.AVAILABLE_FROM_SUPPLIER.primary).toMatch(/2 working days/);
    expect(DISPATCH_COPY.OUT_OF_STOCK.primary).toMatch(/Notify me/i);
  });
});

describe('effectiveStockState', () => {
  it('honours an explicit stockState when present', () => {
    expect(effectiveStockState({ stockState: 'IN_STOCK', availableQty: 0 })).toBe('IN_STOCK');
    expect(effectiveStockState({ stockState: 'AVAILABLE_FROM_SUPPLIER' })).toBe('AVAILABLE_FROM_SUPPLIER');
    expect(effectiveStockState({ stockState: 'OUT_OF_STOCK', availableQty: 100 })).toBe('OUT_OF_STOCK');
  });

  it('falls back to availableQty when stockState is missing', () => {
    expect(effectiveStockState({ availableQty: 5 })).toBe('IN_STOCK');
    expect(effectiveStockState({ availableQty: 0 })).toBe('OUT_OF_STOCK');
    expect(effectiveStockState({})).toBe('OUT_OF_STOCK');
  });
});

describe('isSellable', () => {
  it('treats both green states as sellable', () => {
    expect(isSellable('IN_STOCK')).toBe(true);
    expect(isSellable('AVAILABLE_FROM_SUPPLIER')).toBe(true);
    expect(isSellable('OUT_OF_STOCK')).toBe(false);
  });
});
