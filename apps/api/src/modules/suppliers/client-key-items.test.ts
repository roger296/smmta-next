/**
 * Validating the client's key-items workbook against the invoice data.
 *
 * Every fixture is real: SKU 135575 genuinely appears in the sheet against four
 * different products, and the invoices genuinely say it is liquid egg white.
 */
import { describe, expect, it } from 'vitest';
import {
  descriptionsAgree, descriptionTokens, nameByCode, nameByDescription, normaliseCode, validate,
  type ClientKeyItem,
} from './client-key-items.js';

const item = (p: Partial<ClientKeyItem>): ClientKeyItem => ({
  suggestedName: 'Medium Eggs', stockItem: 'Brakes Med Eggs (Shell On)', category: 'ingredient',
  groupId: '75', sku: '135575', supplier: 'Brakes', packSize: '1X180', sheet: 'Sheet1', ...p,
});

const invoices = new Map([
  ['135575', 'Noble Free Range Liquid Egg White'],
  ['26089', 'Vinyl Gloves Clear Lge PF GD09L'],
  ['133561', 'Brakes Essentials Fully Baked Tomato & Cheese Quiche Slabs'],
  ['11127', 'Wholesome Farms Unsalted Butter'],
]);

describe('normaliseCode', () => {
  it('reads the client s spacing and the invoice run s as one code', () => {
    expect(normaliseCode('A 10678')).toBe(normaliseCode('A10678'));
  });
});

describe('descriptionTokens', () => {
  /** A row's text often repeats its own code, which would match anything. */
  it('drops a leading code from the description', () => {
    const t = descriptionTokens('C 135575 - Noble Free Range Liquid Egg White 1 x 1kg');
    expect(t.has('135575')).toBe(false);
    expect(t.has('noble')).toBe(true);
  });
});

describe('descriptionsAgree', () => {
  /**
   * The client abbreviates. Measured symmetrically this reads as a conflict,
   * and it is plainly the same quiche.
   */
  it('accepts the client s abbreviation of a longer invoice line', () => {
    expect(descriptionsAgree(
      'Brake Esse Tom & Cheese Quiche',
      'Brakes Essentials Fully Baked Tomato & Cheese Quiche Slabs',
    )).toBe(true);
  });

  it('rejects two genuinely different goods', () => {
    expect(descriptionsAgree('Brakes Med Eggs (Shell On)', 'Vinyl Gloves Clear Lge PF GD09L')).toBe(false);
    expect(descriptionsAgree('Brakes Caster Sugar', 'Wholesome Farms Unsalted Butter')).toBe(false);
  });
});

describe('validate', () => {
  it('trusts a row whose code and description agree with the invoices', () => {
    const [v] = validate(
      [item({ sku: '133561', stockItem: 'Brake Esse Tom & Cheese Quiche', suggestedName: 'Tomato & Cheese Quiche' })],
      invoices,
    );
    expect(v!.trust).toBe('sku-and-description');
  });

  /** The misalignment, exactly as the workbook has it. */
  it('flags a row whose code the invoices say is something else', () => {
    const [v] = validate([item({})], invoices);
    expect(v!.trust).toBe('sku-mismatched');
    expect(v!.invoiceSaysInstead).toBe('Noble Free Range Liquid Egg White');
  });

  it('falls back to the description when no invoice line carries the code', () => {
    const [v] = validate([item({ sku: 'NEVER-BILLED' })], invoices);
    expect(v!.trust).toBe('description-only');
  });

  it('falls back to the description when the row has no code at all', () => {
    expect(validate([item({ sku: '' })], invoices)[0]!.trust).toBe('description-only');
  });
});

describe('nameByCode', () => {
  it('maps a corroborated code to the name the client chose', () => {
    const v = validate(
      [item({ sku: '133561', stockItem: 'Brake Esse Tom & Cheese Quiche', suggestedName: 'Tomato & Cheese Quiche' })],
      invoices,
    );
    expect(nameByCode(v).get('133561')).toBe('Tomato & Cheese Quiche');
  });

  it('never keys on a mismatched row, however confidently it is written', () => {
    expect(nameByCode(validate([item({})], invoices)).has('135575')).toBe(false);
  });

  /**
   * 24 codes in the workbook carry two or more different names. Picking one
   * would be guessing which row was pasted correctly.
   */
  it('drops a code the client gave two different names', () => {
    const v = validate(
      [
        item({ sku: '11127', stockItem: 'Wholesome Farms Unsalted Butter', suggestedName: 'Unsalted Butter' }),
        item({ sku: '11127', stockItem: 'Wholesome Farms Unsalted Butter', suggestedName: 'Caster Sugar' }),
      ],
      invoices,
    );
    expect(nameByCode(v).has('11127')).toBe(false);
  });
});

describe('nameByDescription', () => {
  /** The axis the misaligned rows still support: the client read the text. */
  it('keeps the name against the description even when the SKU was wrong', () => {
    const v = validate([item({})], invoices);
    const byDesc = nameByDescription(v);
    expect(byDesc).toHaveLength(1);
    expect(byDesc[0]!.name).toBe('Medium Eggs');
  });

  it('collapses the sheets repeated pairings to one entry', () => {
    const v = validate([item({}), item({}), item({})], invoices);
    expect(nameByDescription(v)).toHaveLength(1);
  });
});
