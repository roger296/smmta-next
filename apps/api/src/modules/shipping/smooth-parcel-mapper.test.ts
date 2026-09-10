/**
 * Smooth Parcel shipment payload rules, from the user guide. Pure: no database
 * or network, so it runs anywhere.
 */
import { describe, expect, it } from 'vitest';
import {
  LabelDataError,
  buildSmoothParcelOrder,
  clip,
  splitName,
  toIso3,
  type LabelOrderInput,
  type MapperOptions,
} from './smooth-parcel-mapper.js';

const opts: MapperOptions = {
  senderName: 'CleverDeals',
  defaultPhone: '',
  fallbackEmail: '',
  defaultWeightKg: 1.3,
  defaultBoxCm: { length: 20, width: 20, height: 8 },
  shippingDate: new Date('2026-09-10T10:00:00.000Z'),
};

const order = (overrides: Partial<LabelOrderInput> = {}): LabelOrderInput => ({
  orderNumber: 'STORE-EBE1CE630088',
  orderDate: '2026-09-10',
  customerName: 'Roger Test',
  customerEmail: 'roger@example.invalid',
  address: {
    contactName: 'Roger Test',
    line1: 'Close Cottage',
    line2: 'Mow Lane',
    city: 'Stoke-on-Trent',
    region: null,
    postCode: 'ST7 3PL',
    country: 'GB',
    phone: '07700 900123',
  },
  lines: [
    {
      sku: 'V3-PLA-BAS-BROWN',
      name: 'Landau PLA Basic 1.75mm 1kg — Brown',
      quantity: 2,
      unitPriceGbp: 12.28,
      weightKg: 1,
      lengthCm: 20,
      widthCm: 20,
      heightCm: 8,
    },
  ],
  ...overrides,
});

describe('buildSmoothParcelOrder', () => {
  it('uses the order number as transaction and reference', () => {
    const p = buildSmoothParcelOrder(order(), opts);
    expect(p.TransactionID).toBe('STORE-EBE1CE630088');
    expect(p.OrderReference).toBe('STORE-EBE1CE630088');
  });

  it('splits the recipient into first and last name', () => {
    const p = buildSmoothParcelOrder(order(), opts);
    expect([p.FirstName, p.LastName]).toEqual(['Roger', 'Test']);
    expect([p.ShipmentFirstName, p.ShipmentLastName]).toEqual(['Roger', 'Test']);
  });

  it('maps the address, repeating the town as region and using ISO-3 country', () => {
    const p = buildSmoothParcelOrder(order(), opts);
    expect(p.HouseNameNumber).toBe('Close Cottage');
    expect(p.Street).toBe('Mow Lane');
    expect(p.City).toBe('Stoke-on-Trent');
    expect(p.Region).toBe('Stoke-on-Trent');
    expect(p.PostalCode).toBe('ST7 3PL');
    expect(p.Country).toBe('GBR');
  });

  it('repeats line 1 as the street when there is no second line', () => {
    const o = order();
    const p = buildSmoothParcelOrder({ ...o, address: { ...o.address, line2: null } }, opts);
    expect(p.Street).toBe('Close Cottage');
  });

  it('clips address lines to 35 characters to avoid label truncation', () => {
    const o = order();
    const long = 'Unit 12, The Very Long Industrial Estate Business Park';
    const p = buildSmoothParcelOrder({ ...o, address: { ...o.address, line1: long } }, opts);
    expect(p.HouseNameNumber.length).toBeLessThanOrEqual(35);
  });

  it('uses the customer phone, then the configured default, then a placeholder', () => {
    expect(buildSmoothParcelOrder(order(), opts).CustomerPhone1).toBe('07700 900123');
    const o = order();
    const noPhone = { ...o, address: { ...o.address, phone: null } };
    expect(buildSmoothParcelOrder(noPhone, { ...opts, defaultPhone: '01260 000000' }).CustomerPhone1).toBe('01260 000000');
    expect(buildSmoothParcelOrder(noPhone, opts).CustomerPhone1).toBe('00000000000');
  });

  it('maps each line with its per-unit price and weight', () => {
    const [item] = buildSmoothParcelOrder(order(), opts).OrderDetailList;
    expect(item).toMatchObject({
      ItemID: 'V3-PLA-BAS-BROWN',
      ProductSKU: 'V3-PLA-BAS-BROWN',
      Quantity: 2,
      Price: 12.28,
      Weight: 1,
      Length: 20,
      Width: 20,
      Height: 8,
    });
  });

  it('sends units as the strings the API contract expects', () => {
    const [item] = buildSmoothParcelOrder(order(), opts).OrderDetailList;
    expect([item!.WeightUnits, item!.LWHUnit]).toEqual(['kg', 'cm']);
  });

  it('falls back to the default weight and box when a product has none', () => {
    const o = order();
    const bare = { ...o.lines[0]!, weightKg: null, lengthCm: null, widthCm: 0, heightCm: null };
    const [item] = buildSmoothParcelOrder({ ...o, lines: [bare] }, opts).OrderDetailList;
    expect(item).toMatchObject({ Weight: 1.3, Length: 20, Width: 20, Height: 8 });
  });

  it('requests tracked delivery, duty paid', () => {
    const p = buildSmoothParcelOrder(order(), opts);
    expect(p.TrackedRequired).toBe(true);
    expect(p.ddlDD).toBe(2);
  });

  it('refuses an order missing essentials, naming what is missing', () => {
    const o = order();
    const bad = { ...o, address: { ...o.address, postCode: '', line1: null } };
    expect(() => buildSmoothParcelOrder(bad, opts)).toThrow(LabelDataError);
    try {
      buildSmoothParcelOrder(bad, opts);
    } catch (err) {
      expect((err as LabelDataError).missing).toEqual(expect.arrayContaining(['postcode', 'address line 1']));
    }
  });

  it('requires an email, using the fallback when the customer has none', () => {
    const noEmail = order({ customerEmail: null });
    expect(() => buildSmoothParcelOrder(noEmail, opts)).toThrow(/customer email/);
    expect(
      buildSmoothParcelOrder(noEmail, { ...opts, fallbackEmail: 'sales@example.invalid' }).CustomerEmailAddress1,
    ).toBe('sales@example.invalid');
  });

  it('refuses an order with no lines', () => {
    expect(() => buildSmoothParcelOrder(order({ lines: [] }), opts)).toThrow(/order lines/);
  });
});

describe('helpers', () => {
  it('splitName uses a single word for both names', () => {
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: 'Cher' });
    expect(splitName('  Mary  Ann   Smith ')).toEqual({ first: 'Mary Ann', last: 'Smith' });
  });

  it('toIso3 maps common codes and passes through unknown ones', () => {
    expect(toIso3('GB')).toBe('GBR');
    expect(toIso3('uk')).toBe('GBR');
    expect(toIso3('United Kingdom')).toBe('GBR');
    expect(toIso3('IRL')).toBe('IRL');
  });

  it('clip collapses whitespace and caps length', () => {
    expect(clip('  a   b  ')).toBe('a b');
    expect(clip('x'.repeat(50), 35)).toHaveLength(35);
    expect(clip(null)).toBe('');
  });
});
