import { describe, expect, it } from 'vitest';
import { deliveryNote, summariseParcels } from './delivery';

const lines = [
  { productId: 'p-hoodie', name: 'Hoodie' },
  { productId: 'p-tee', name: 'T-shirt' },
  { productId: 'p-cap', name: null },
];

describe('summariseParcels', () => {
  it('labels a single parcel plainly', () => {
    const r = summariseParcels(
      { totalGbp: '7.00', parcels: [{ supplierId: 's1', supplierName: null, chargeGbp: '7.00', productIds: ['p-hoodie', 'p-tee'] }] },
      lines,
    );
    expect(r).toEqual([{ label: 'Delivery', chargeGbp: '7.00', itemNames: ['Hoodie', 'T-shirt'] }]);
  });

  it('numbers several parcels and names a supplier only when allowed', () => {
    const r = summariseParcels(
      {
        totalGbp: '17.50',
        parcels: [
          { supplierId: 's1', supplierName: null, chargeGbp: '10.50', productIds: ['p-hoodie'] },
          { supplierId: 's2', supplierName: 'Uneek', chargeGbp: '7.00', productIds: ['p-tee', 'p-cap'] },
        ],
      },
      lines,
    );
    expect(r.map((p) => p.label)).toEqual(['Delivery · parcel 1', 'Delivery · parcel 2 from Uneek']);
    expect(r[1]!.itemNames).toEqual(['T-shirt', 'Item']);
  });
});

describe('deliveryNote', () => {
  it('explains several parcels and that more items cost nothing extra', () => {
    expect(deliveryNote(2)).toMatch(/2 different suppliers.*2 parcels.*no extra delivery cost/);
  });
  it('reassures a single-parcel basket', () => {
    expect(deliveryNote(1)).toBe('One delivery charge, however many items you add.');
  });
});
