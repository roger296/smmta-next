import { describe, expect, it } from 'vitest';
import type { Product } from '@/lib/api-types';
import {
  bookableLines,
  describeOrderLine,
  linesFromOrder,
  orderLineFor,
  overDeliveries,
  stillToComeAfter,
  type OrderContext,
} from './order-booking';

const product = (id: string, name: string, purchaseUom: string) => ({ id, name, purchaseUom }) as unknown as Product;
const FLOUR = product('p-flour', 'Plain flour', 'sack');
const SUGAR = product('p-sugar', 'Caster sugar', 'bag');
const STRAY = product('p-stray', 'Paper cups', 'case');

const ORDER: OrderContext = {
  id: 'po-1',
  poNumber: 'PO-000123',
  supplierName: 'Brakes',
  lines: [
    { id: 'l-flour', product: FLOUR, ordered: 10, received: 4, outstanding: 6 },
    { id: 'l-sugar', product: SUGAR, ordered: 5, received: 5, outstanding: 0 },
  ],
};

describe('laying an order out', () => {
  it('only lines still to come, each at what is still to come', () => {
    expect(linesFromOrder(ORDER)).toEqual([
      { product: FLOUR, qtyPurchase: 6, order: { purchaseOrderLineId: 'l-flour', ordered: 10, received: 4, outstanding: 6 } },
    ]);
  });

  it('a scanned product finds its order line, even one already complete', () => {
    expect(orderLineFor(ORDER, 'p-sugar')).toMatchObject({ purchaseOrderLineId: 'l-sugar', outstanding: 0 });
    expect(orderLineFor(ORDER, 'p-stray')).toBeUndefined();
    expect(orderLineFor(null, 'p-flour')).toBeUndefined();
  });

  it('describes a line against the order', () => {
    expect(describeOrderLine(linesFromOrder(ORDER)[0]!.order, FLOUR)).toBe('Ordered 10 sack · 4 in already · 6 to come');
    expect(describeOrderLine(orderLineFor(ORDER, 'p-sugar')!, SUGAR)).toBe('Ordered 5 bag · all already in');
  });
});

describe('what gets booked', () => {
  const flour = (qty: number) => ({ product: FLOUR, qtyPurchase: qty, order: orderLineFor(ORDER, 'p-flour') });

  it('a line at 0 books nothing and stays on the order', () => {
    expect(bookableLines([flour(0)])).toEqual([]);
    expect(stillToComeAfter(ORDER, [flour(0)])).toBe(1);
  });

  it('part of a line leaves it still to come; all of it closes it', () => {
    expect(stillToComeAfter(ORDER, [flour(2)])).toBe(1);
    expect(stillToComeAfter(ORDER, [flour(6)])).toBe(0);
  });

  it('more than is still to come is an over-delivery, by how much', () => {
    expect(overDeliveries([flour(8)], true)).toEqual([{ name: 'Plain flour', unit: 'sack', extra: 2, notOnOrder: false }]);
    expect(overDeliveries([flour(6)], true)).toEqual([]);
  });

  it('two lines of one order line are added together', () => {
    expect(overDeliveries([flour(4), flour(4)], true)).toEqual([expect.objectContaining({ extra: 2 })]);
  });

  it('a late extra on a complete line, and an item not on the order, are both over', () => {
    const lines = [
      { product: SUGAR, qtyPurchase: 1, order: orderLineFor(ORDER, 'p-sugar') },
      { product: STRAY, qtyPurchase: 3 },
    ];
    expect(overDeliveries(lines, true)).toEqual([
      { name: 'Paper cups', unit: 'case', extra: 3, notOnOrder: true },
      { name: 'Caster sugar', unit: 'bag', extra: 1, notOnOrder: false },
    ]);
  });

  it('with no order, nothing is an over-delivery', () => {
    expect(overDeliveries([{ product: STRAY, qtyPurchase: 3 }], false)).toEqual([]);
  });
});
