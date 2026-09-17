import { describe, expect, it } from 'vitest';
import {
  planFixes,
  type Contradiction,
  type FixTarget,
  type LiveMapping,
} from './supplier-mapping-fix.js';

const key = (supplier: string, sku: string) => `${supplier.trim().toLowerCase()}\u0000${sku.trim().toLowerCase()}`;

let n = 0;
function mapping(over: Partial<LiveMapping> = {}): LiveMapping {
  n += 1;
  return {
    id: `m${n}`, supplier: 'Brakes', supplierSku: '11127', codeDigits: '11127',
    productId: 'p-sugar', productName: 'Caster Sugar', productStockCode: 'BAKE-CAST-SUGR',
    ...over,
  };
}

const CONTRA = (m: LiveMapping, description: string, linesSeen = 10): Contradiction => ({
  mapping: m, invoiceDescription: description, linesSeen,
});

function run(args: {
  contradictions: Contradiction[];
  allMappings?: LiveMapping[];
  corrections?: Array<[string, string, string]>;
  sheet?: Array<[string, string, FixTarget]>;
  catalogue?: Array<[string, FixTarget]>;
}) {
  return planFixes({
    contradictions: args.contradictions,
    allMappings: args.allMappings ?? args.contradictions.map((c) => c.mapping),
    corrections: new Map((args.corrections ?? []).map(([s, sku, code]) => [key(s, sku), code])),
    sheetTargets: new Map((args.sheet ?? []).map(([s, sku, t]) => [key(s, sku), t])),
    byStockCode: new Map(args.catalogue ?? []),
    key,
  });
}

const CARROTS: FixTarget = { productId: 'p-carr', productName: 'Carrots', stockCode: 'CARR' };
const BUTTER: FixTarget = { productId: 'p-butter', productName: 'Unsalted Butter', stockCode: 'DAIR-UNSL-BUTR' };

describe('planFixes - delete surplus', () => {
  it('deletes the wrong row when a sibling spelling already has it right', () => {
    // The real Brakes 11127: Caster Sugar beside C 11127 -> Unsalted Butter,
    // against 158 invoice lines of "Wholesome Farms Unsalted Butter".
    const wrong = mapping();
    const right = mapping({ supplierSku: 'C 11127', productId: 'p-butter', productName: 'Unsalted Butter' });
    const plan = run({
      contradictions: [CONTRA(wrong, 'Wholesome Farms Unsalted Butter', 158)],
      allMappings: [wrong, right],
    });
    expect(plan.deletes).toHaveLength(1);
    expect(plan.deletes[0]).toMatchObject({ action: 'DELETE_SURPLUS', source: 'sibling' });
    expect(plan.deletes[0]!.target).toMatchObject({ productName: 'Unsalted Butter' });
    expect(plan.repoints).toEqual([]);
  });

  it('deletes all three wrong rows of a group, not just the first', () => {
    // Brakes 10678: three wrong rows beside A 10678 -> Cocoa Powder.
    const a = mapping({ productName: 'Baking Parchment Roll', productId: 'p-parch', codeDigits: '10678', supplierSku: '10678' });
    const b = mapping({ productName: 'Black Refuse Sacks', productId: 'p-sacks', codeDigits: '10678', supplierSku: '10678' });
    const c = mapping({ productName: 'Pistachio Kernels', productId: 'p-pist', codeDigits: '10678', supplierSku: '10678' });
    const good = mapping({ productName: 'Cocoa Powder', productId: 'p-cocoa', codeDigits: '10678', supplierSku: 'A 10678' });
    const desc = 'Freshers Fat Reduced Cocoa Powder';
    const plan = run({
      contradictions: [CONTRA(a, desc, 48), CONTRA(b, desc, 48), CONTRA(c, desc, 48)],
      allMappings: [a, b, c, good],
    });
    expect(plan.deletes).toHaveLength(3);
    expect(plan.refusals).toEqual([]);
  });

  it('will not treat another CONDEMNED row as the correct sibling', () => {
    // Two wrong rows and no right one. Neither may adopt the other.
    const a = mapping({ productName: 'Caster Sugar', productId: 'p-a' });
    const b = mapping({ productName: 'Frozen Fruits', productId: 'p-b' });
    const plan = run({
      contradictions: [CONTRA(a, 'Noble Free Range Liquid Egg White'), CONTRA(b, 'Noble Free Range Liquid Egg White')],
      allMappings: [a, b],
    });
    expect(plan.deletes).toEqual([]);
    expect(plan.refusals).toHaveLength(2);
  });

  it('leaves a code with no digits alone - NOSKU is not a code to group on', () => {
    const a = mapping({ supplierSku: 'NOSKU', codeDigits: null, productId: 'p-a' });
    const b = mapping({ supplierSku: 'NOSKU', codeDigits: null, productId: 'p-b', productName: 'Unsalted Butter' });
    const plan = run({
      contradictions: [CONTRA(a, 'Wholesome Farms Unsalted Butter')],
      allMappings: [a, b],
    });
    expect(plan.deletes).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
  });
});

describe('planFixes - repoint', () => {
  it('moves the code to what the decisions sheet says when no sibling is right', () => {
    const m = mapping({ supplierSku: '10230', codeDigits: '10230', productName: 'Black Paper Straws', productId: 'p-straws' });
    const plan = run({
      contradictions: [CONTRA(m, 'Cucumber Single BB', 76)],
      sheet: [['Brakes', '10230', { productId: 'p-cuke', productName: 'Cucumber', stockCode: 'PROD-CUCU-MBER' }]],
    });
    expect(plan.repoints).toHaveLength(1);
    expect(plan.repoints[0]).toMatchObject({ action: 'REPOINT', source: 'decision-sheet' });
    expect(plan.repoints[0]!.target).toMatchObject({ stockCode: 'PROD-CUCU-MBER' });
  });

  it('refuses when the sheet names a product the invoices ALSO contradict', () => {
    // Two independent sources disagreeing is no basis to move anything.
    const m = mapping({ supplierSku: '10417', codeDigits: '10417', productName: 'Popcorn', productId: 'p-pop' });
    const plan = run({
      contradictions: [CONTRA(m, 'Prepared Baton Carrots', 7)],
      sheet: [['Brakes', '10417', { productId: 'p-pop2', productName: 'Popcorn', stockCode: 'POPC' }]],
    });
    expect(plan.repoints).toEqual([]);
    expect(plan.refusals[0]!.reason).toContain('invoices contradict');
  });

  it('refuses when nothing names a target', () => {
    const m = mapping({ supplierSku: '99999', codeDigits: '99999' });
    const plan = run({ contradictions: [CONTRA(m, 'Something Else Entirely')] });
    expect(plan.refusals[0]!.reason).toContain('does not cover this code');
  });

  it('refuses a sheet target that is the product it is already on', () => {
    const m = mapping({ productId: 'p-sugar', productName: 'Caster Sugar' });
    const plan = run({
      contradictions: [CONTRA(m, 'Wholesome Farms Unsalted Butter')],
      sheet: [['Brakes', '11127', { productId: 'p-sugar', productName: 'Caster Sugar', stockCode: 'BAKE-CAST-SUGR' }]],
    });
    expect(plan.repoints).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
  });
});

describe('planFixes - corrections outrank everything', () => {
  it('uses the correction over the sheet', () => {
    // The real case: the sheet said POPC for "Prepared Baton Carrots".
    const m = mapping({ supplierSku: '10417', codeDigits: '10417', productName: 'Popcorn', productId: 'p-pop' });
    const plan = run({
      contradictions: [CONTRA(m, 'Prepared Baton Carrots', 7)],
      corrections: [['Brakes', '10417', 'CARR']],
      sheet: [['Brakes', '10417', { productId: 'p-pop2', productName: 'Popcorn', stockCode: 'POPC' }]],
      catalogue: [['CARR', CARROTS]],
    });
    expect(plan.repoints).toHaveLength(1);
    expect(plan.repoints[0]).toMatchObject({ source: 'correction' });
    expect(plan.repoints[0]!.target).toMatchObject({ stockCode: 'CARR' });
  });

  it('uses the correction over a correct-looking sibling', () => {
    const wrong = mapping();
    const sibling = mapping({ supplierSku: 'C 11127', productId: 'p-butter', productName: 'Unsalted Butter' });
    const plan = run({
      contradictions: [CONTRA(wrong, 'Wholesome Farms Unsalted Butter', 158)],
      allMappings: [wrong, sibling],
      corrections: [['Brakes', '11127', 'DAIR-UNSL-BUTR']],
      catalogue: [['DAIR-UNSL-BUTR', BUTTER]],
    });
    expect(plan.deletes).toEqual([]);
    expect(plan.repoints).toHaveLength(1);
  });

  it('refuses a correction naming a stock code no product has, rather than guessing', () => {
    const m = mapping();
    const plan = run({
      contradictions: [CONTRA(m, 'Wholesome Farms Unsalted Butter')],
      corrections: [['Brakes', '11127', 'NOT-A-CODE']],
    });
    expect(plan.repoints).toEqual([]);
    expect(plan.refusals[0]!.reason).toContain('NOT-A-CODE');
  });
});
