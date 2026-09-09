/**
 * Mapping a saved product onto the form's fields.
 *
 * The duplicate flow depends on this being complete: a field missing from the
 * mapping is not a visible error, it is a blank box on a form that looks
 * finished, and the copy saves without it. The coverage test below is the real
 * point of this file — it fails when someone adds a field to the form schema
 * and forgets the mapping.
 */
import { describe, expect, it } from 'vitest';
import { productFormSchema, productToFormValues } from './product-form';

const PRODUCT = {
  name: 'Landau PLA Basic 1.75mm 1kg — Black',
  stockCode: 'V3-PLA-BAS-BLACK',
  manufacturerId: '11111111-1111-4111-8111-111111111111',
  manufacturerPartNumber: 'MPN-123',
  description: 'A spool of black PLA.',
  expectedNextCost: '3.42',
  minSellingPrice: '6.00',
  maxSellingPrice: '12.00',
  ean: '5012345678900',
  productType: 'PHYSICAL' as const,
  requireSerialNumber: false,
  requireBatchNumber: true,
  weight: '1.300',
  countryOfOrigin: 'CN',
  hsCode: '3916',
  supplierId: '22222222-2222-4222-8222-222222222222',
  defaultWarehouseId: '33333333-3333-4333-8333-333333333333',
};

describe('productToFormValues', () => {
  it('covers every field in the form schema', () => {
    // The guard that matters. Adding a field to the form without adding it here
    // would let a duplicate silently lose it.
    const mapped = Object.keys(productToFormValues(PRODUCT)).sort();
    const schemaFields = Object.keys(productFormSchema.shape).sort();
    expect(mapped).toEqual(schemaFields);
  });

  it('copies the values across', () => {
    const v = productToFormValues(PRODUCT);
    expect(v.name).toBe(PRODUCT.name);
    expect(v.stockCode).toBe('V3-PLA-BAS-BLACK');
    expect(v.manufacturerPartNumber).toBe('MPN-123');
    expect(v.ean).toBe('5012345678900');
    expect(v.productType).toBe('PHYSICAL');
    expect(v.requireBatchNumber).toBe(true);
    expect(v.countryOfOrigin).toBe('CN');
    expect(v.supplierId).toBe(PRODUCT.supplierId);
  });

  it('converts decimal strings to numbers for the money and weight inputs', () => {
    const v = productToFormValues(PRODUCT);
    expect(v.expectedNextCost).toBe(3.42);
    expect(v.minSellingPrice).toBe(6);
    expect(v.maxSellingPrice).toBe(12);
    expect(v.weight).toBe(1.3);
  });

  it('leaves optional numbers undefined rather than zero when unset', () => {
    // Zero is a real price. Coercing an unset field to 0 would quietly turn
    // "no ceiling" into "free", which volume pricing reads as a valid floor.
    const v = productToFormValues({ ...PRODUCT, minSellingPrice: null, maxSellingPrice: null, weight: null });
    expect(v.minSellingPrice).toBeUndefined();
    expect(v.maxSellingPrice).toBeUndefined();
    expect(v.weight).toBeUndefined();
  });

  it('turns null text fields into empty strings the inputs can render', () => {
    const v = productToFormValues({
      ...PRODUCT,
      stockCode: null,
      description: null,
      ean: null,
      supplierId: null,
    });
    expect(v.stockCode).toBe('');
    expect(v.description).toBe('');
    expect(v.ean).toBe('');
    expect(v.supplierId).toBe('');
  });

  it('defaults expectedNextCost to 0, which the form requires', () => {
    const v = productToFormValues({ ...PRODUCT, expectedNextCost: null });
    expect(v.expectedNextCost).toBe(0);
  });

  describe('omit', () => {
    it('drops the fields a duplicate must not copy', () => {
      const v = productToFormValues(PRODUCT, ['name', 'stockCode']);
      expect('name' in v).toBe(false);
      expect('stockCode' in v).toBe(false);
      // Everything else still comes through.
      expect(v.minSellingPrice).toBe(6);
      expect(v.manufacturerId).toBe(PRODUCT.manufacturerId);
    });

    it('leaves the values untouched when nothing is omitted', () => {
      expect(productToFormValues(PRODUCT, [])).toEqual(productToFormValues(PRODUCT));
    });
  });
});
