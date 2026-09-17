import { describe, expect, it } from 'vitest';
import { auditMappings, verdictFor, type InvoiceFact, type MappingRow } from './supplier-mapping-audit.js';

const key = (supplier: string, sku: string) => `${supplier.toLowerCase()}\u0000${sku.trim().toLowerCase()}`;

describe('verdictFor', () => {
  // Every one of these is a real row the reviewed-decisions run refused to
  // overwrite on 17 Sept 2026, with the description taken from the invoices.
  it.each([
    ['Olives', 'Coca-Cola Original Taste Can'],
    ['Black Paper Straws', 'Cucumber Single BB'],
    ['Whole Eggs', 'Vinyl Gloves Clear Lge PF GD09L'],
    ['Caster Sugar', 'Noble Free Range Liquid Egg White'],
    ['Hazelnuts', 'Preema Vanilla Essence'],
    ['Mushroom Arancini', 'Red Cherry Tomatoes'],
    ['Baking Parchment Roll', 'Freshers Fat Reduced Cocoa Powder'],
    ['Frozen Fruits', 'Tate & Lyle Icing Sugar'],
    ['Caster Sugar', 'Sysco Classic Extended Life Rapeseed Oil'],
    ['Olives', 'Sysco Classc Grt Mild White Cheddr'],
    ['Pizza/Marinara Sauce', 'Bar Mix Olives (Pitted)'],
  ])('calls %j against %j a contradiction', (product, description) => {
    expect(verdictFor(product, description)).toBe('CONTRADICTS');
  });

  // The other five from that same list. These are judgement calls, not
  // defects, and must not be buried among the eleven above.
  it.each([
    ['Milk', 'Arla UHT Whole Milk'],
    ['Bacardi Carta Oro', 'BACARDI GOLD ORO 70CL'],
    ['Strawberry Shrub', 'BRISTOL SYRUP STRAWBERRY 75CL'],
    ['Marlish Still Water', 'Ice Valley Still Sprng Water'],
  ])('leaves %j against %j for a human', (product, description) => {
    expect(verdictFor(product, description)).not.toBe('CONTRADICTS');
  });

  it.each([
    ['Unsalted Butter', 'Wholesome Farms Unsalted Butter'],
    ['Cornflour', 'Sysco Classic Cornflour'],
    ['Egg Whites', 'Noble Free Range Liquid Egg White'],
    ['Napkins', 'Brakes 2Ply 32cm White Napkin'],
    ['Cocoa Powder', 'Dr Oetker Cocoa Powder'],
  ])('accepts %j against %j', (product, description) => {
    expect(verdictFor(product, description)).toBe('AGREES');
  });

  it('does not call a row wrong when there are no words to judge with', () => {
    // A description of "1kg" has no significant tokens. Silence, not a finding.
    expect(verdictFor('Caster Sugar', '1kg')).toBe('PLAUSIBLE');
    expect(verdictFor('', 'Coca-Cola Original Taste Can')).toBe('PLAUSIBLE');
  });
});

function row(over: Partial<MappingRow> = {}): MappingRow {
  return {
    supplier: 'Brakes', supplierSku: '742', productName: 'Coca-Cola Cans',
    productStockCode: 'SOFT-COKE-CANS', createdOn: '2026-07-28', ...over,
  };
}

const facts = (...pairs: Array<[string, string, string, number]>): Map<string, InvoiceFact> =>
  new Map(pairs.map(([s, sku, description, linesSeen]) => [key(s, sku), { description, linesSeen }]));

describe('auditMappings', () => {
  it('reports a contradiction with the evidence beside it', () => {
    const r = auditMappings(
      [row({ productName: 'Olives', productStockCode: 'PITT-MIXD-OLIV' })],
      facts(['Brakes', '742', 'Coca-Cola Original Taste Can', 24]),
      key,
    );
    expect(r.checked).toBe(1);
    expect(r.contradicts).toHaveLength(1);
    expect(r.contradicts[0]).toMatchObject({
      supplierSku: '742', productName: 'Olives',
      invoiceDescription: 'Coca-Cola Original Taste Can', linesSeen: 24,
    });
  });

  it('ranks by how much invoice evidence sits behind each one', () => {
    const r = auditMappings(
      [
        row({ supplierSku: '742', productName: 'Olives' }),
        row({ supplierSku: '135575', productName: 'Caster Sugar' }),
      ],
      facts(
        ['Brakes', '742', 'Coca-Cola Original Taste Can', 24],
        ['Brakes', '135575', 'Noble Free Range Liquid Egg White', 123],
      ),
      key,
    );
    expect(r.contradicts.map((c) => c.supplierSku)).toEqual(['135575', '742']);
  });

  it('says nothing about a code no invoice line carries', () => {
    const r = auditMappings([row({ supplierSku: 'NEVER-BILLED' })], facts(), key);
    expect(r.noEvidence).toBe(1);
    expect(r.checked).toBe(0);
    expect(r.contradicts).toEqual([]);
  });

  it('keeps plausible rows out of the findings list', () => {
    const r = auditMappings(
      [row({ supplierSku: '123027', productName: 'Milk', productStockCode: 'DAIR-WHOL-MILK' })],
      facts(['Brakes', '123027', 'Arla UHT Whole Milk', 42]),
      key,
    );
    expect(r.contradicts).toEqual([]);
    expect(r.plausible).toHaveLength(1);
  });

  it('finds one code sitting on two products', () => {
    const r = auditMappings(
      [
        row({ supplierSku: '742', productName: 'Olives', productStockCode: 'PITT-MIXD-OLIV' }),
        row({ supplierSku: '742', productName: 'Coca-Cola Cans', productStockCode: 'SOFT-COKE-CANS' }),
      ],
      facts(['Brakes', '742', 'Coca-Cola Original Taste Can', 24]),
      key,
    );
    expect(r.duplicateCodes).toHaveLength(1);
    expect(r.duplicateCodes[0]!.products.map((p) => p.stockCode).sort())
      .toEqual(['PITT-MIXD-OLIV', 'SOFT-COKE-CANS']);
  });

  it('groups the spelling variants the July import filed as separate lines', () => {
    const r = auditMappings(
      [
        row({ supplierSku: '149492', productName: 'Ariel Laundry Powder', productStockCode: 'ARIE-LAUN-POWD' }),
        row({ supplierSku: 'A 149492', productName: 'Ariel Laundry Powder', productStockCode: 'ARIE-LAUN-POWD' }),
        row({ supplierSku: 'A149492', productName: 'Ariel Laundry Powder', productStockCode: 'ARIE-LAUN-POWD' }),
      ],
      facts(),
      key,
    );
    expect(r.spellingGroups).toHaveLength(1);
    expect(r.spellingGroups[0]).toMatchObject({ digits: '149492', sameProduct: true });
    expect(r.spellingGroups[0]!.spellings).toHaveLength(3);
  });

  it('marks a spelling group whose rows disagree about the product', () => {
    const r = auditMappings(
      [
        row({ supplierSku: '113654', productName: 'Soya Milk', productStockCode: 'DAIR-SOYA-MILK' }),
        row({ supplierSku: 'C 113654', productName: 'Oat Milk', productStockCode: 'DAIR-OAT-MILK' }),
      ],
      facts(),
      key,
    );
    expect(r.spellingGroups[0]!.sameProduct).toBe(false);
  });

  it('does not group two genuinely different codes', () => {
    const r = auditMappings(
      [row({ supplierSku: '149492' }), row({ supplierSku: '113654' })],
      facts(),
      key,
    );
    expect(r.spellingGroups).toEqual([]);
  });
});
