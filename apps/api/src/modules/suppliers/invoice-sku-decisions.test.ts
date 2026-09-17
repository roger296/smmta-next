import { describe, expect, it } from 'vitest';
import {
  classifyDecision,
  isPlaceholderName,
  planDecisions,
  stockCodeFor,
  type CatalogueProduct,
  type DecisionRow,
} from './invoice-sku-decisions.js';

const CAT: CatalogueProduct[] = [
  { id: 'p-butter', name: 'Unsalted Butter', stockCode: 'DAIR-UNSL-BUTR' },
  { id: 'p-cheese', name: 'Cheese (unspecified)', stockCode: 'CHEE-UNSP-ONE' },
  { id: 'p-flour', name: 'Self-Raising Flour', stockCode: 'SELF-RASG-FLOR' },
  // Two live products share this name. Neither can be resolved by it.
  { id: 'p-twin-a', name: 'Mint', stockCode: 'PROD-FRSH-MINT' },
  { id: 'p-twin-b', name: 'Mint', stockCode: 'MINT-2' },
];

function row(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    supplier: 'Brakes', supplierSku: '11127', description: 'Wholesome Farms Unsalted Butter',
    decision: 'Y', proposedStockCode: 'DAIR-UNSL-BUTR', newProductName: '', newStockUom: '',
    linesSeen: 158, ...over,
  };
}

describe('classifyDecision', () => {
  it.each([
    ['Y', 'ACCEPT'], ['y', 'ACCEPT'], ['Yes', 'ACCEPT'],
    ['ADD ITEM', 'ADD'], ['add item', 'ADD'],
    ['NOT STOCK', 'SKIP'], ['not stock', 'SKIP'], ['N', 'SKIP'],
    ['', 'UNDECIDED'], ['   ', 'UNDECIDED'],
    ['BAKI-POWD', 'STOCK_CODE'], ['LONG-LIFE-RAPESEED-OIL', 'STOCK_CODE'],
  ])('reads %j as %s', (input, kind) => {
    expect(classifyDecision(input).kind).toBe(kind);
  });

  it('carries the stock code through verbatim, so a typo can be refused by name', () => {
    expect(classifyDecision(' baki-powd ')).toEqual({ kind: 'STOCK_CODE', stockCode: 'baki-powd' });
  });
});

describe('isPlaceholderName', () => {
  it('rejects the placeholder that reached the sheet from the client workbook', () => {
    expect(isPlaceholderName('UNKNOWN - "4 x 2.5kg" (check invoice)')).toBe(true);
  });

  it.each(['TBC', '?', '??', 'unknown', 'Sprinkles (check with Rebecca)'])('rejects %j', (n) => {
    expect(isPlaceholderName(n)).toBe(true);
  });

  it.each([
    'Sprinkletti Party',
    'Sugar Crunch Caramel',
    // A real product whose name merely CONTAINS a bracket must survive.
    'Chocolate (unspecified)',
    'Fruit Juice (Apple, Orange & Pineapple)',
    'Kettle Chips - Lightly Salted',
  ])('accepts %j', (n) => {
    expect(isPlaceholderName(n)).toBe(false);
  });
});

describe('stockCodeFor', () => {
  it('builds the catalogue shape: three four-character segments', () => {
    expect(stockCodeFor('Sugar Crunch Caramel', new Set())).toBe('SUGA-CRUN-CARA');
  });

  it('drops stopwords rather than spending a segment on "of"', () => {
    expect(stockCodeFor('Fruits of the Forest Mix', new Set())).toBe('FRUI-FORE-MIX');
  });

  it('suffixes a clash instead of overwriting, matching the KOPP-2 pair already in the catalogue', () => {
    const taken = new Set(['SUGA-CRUN-CARA']);
    expect(stockCodeFor('Sugar Crunch Caramel', taken)).toBe('SUGA-CRUN-CARA-2');
    expect(stockCodeFor('Sugar Crunch Caramel', taken)).toBe('SUGA-CRUN-CARA-3');
  });

  it('never mints the same code twice within one run', () => {
    const taken = new Set<string>();
    const a = stockCodeFor('Green Scourer', taken);
    const b = stockCodeFor('Green Scourer', taken);
    expect(a).not.toBe(b);
  });

  it('falls back rather than minting an empty code from a name with nothing in it', () => {
    expect(stockCodeFor('the and of', new Set())).toBe('ITEM');
  });
});

describe('planDecisions', () => {
  it('resolves Y through the proposed stock code', () => {
    const plan = planDecisions([row()], CAT);
    expect(plan.refusals).toEqual([]);
    expect(plan.resolved).toHaveLength(1);
    expect(plan.resolved[0]).toMatchObject({ productId: 'p-butter', via: 'ACCEPT' });
  });

  it('lets a written-in stock code overrule the proposal', () => {
    const plan = planDecisions(
      [row({ decision: 'SELF-RASG-FLOR', proposedStockCode: 'DAIR-UNSL-BUTR' })],
      CAT,
    );
    expect(plan.resolved[0]).toMatchObject({ productId: 'p-flour', via: 'STOCK_CODE' });
  });

  it('refuses a stock code no live product has, rather than falling back to the proposal', () => {
    const plan = planDecisions([row({ decision: 'NOPE-NOPE-NOPE' })], CAT);
    expect(plan.resolved).toEqual([]);
    expect(plan.refusals[0]!.reason).toContain('NOPE-NOPE-NOPE');
  });

  it('refuses a Y whose row carries no proposal', () => {
    const plan = planDecisions([row({ decision: 'Y', proposedStockCode: '' })], CAT);
    expect(plan.refusals[0]!.reason).toContain('no proposed stock code');
  });

  it('leaves a blank decision alone - an unanswered question is not an answer', () => {
    const plan = planDecisions([row({ decision: '' })], CAT);
    expect(plan.undecided).toHaveLength(1);
    expect(plan.resolved).toEqual([]);
    expect(plan.refusals).toEqual([]);
  });

  it('skips NOT STOCK without refusing it', () => {
    const plan = planDecisions([row({ decision: 'NOT STOCK' })], CAT);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.refusals).toEqual([]);
  });

  describe('ADD ITEM', () => {
    const add = (over: Partial<DecisionRow>) =>
      row({ decision: 'ADD ITEM', proposedStockCode: '', newProductName: 'Sprinkletti Party', newStockUom: 'kg', ...over });

    it('plans one new product and mints it a code', () => {
      const plan = planDecisions([add({})], CAT);
      expect(plan.refusals).toEqual([]);
      expect(plan.newProducts).toHaveLength(1);
      expect(plan.newProducts[0]).toMatchObject({
        name: 'Sprinkletti Party', stockUom: 'kg', stockCode: 'SPRI-PART', slug: 'spri-part',
      });
    });

    it('gives two rows naming one product ONE product with both codes against it', () => {
      const plan = planDecisions(
        [
          add({ supplier: 'Booker', supplierSku: '077549', newProductName: 'Strathmore Still Glass', newStockUom: 'l' }),
          add({ supplier: 'Makro', supplierSku: '077549', newProductName: 'Strathmore Still Glass', newStockUom: 'l' }),
        ],
        CAT,
      );
      expect(plan.newProducts).toHaveLength(1);
      expect(plan.newProducts[0]!.askedBy).toEqual([
        { supplier: 'Booker', supplierSku: '077549' },
        { supplier: 'Makro', supplierSku: '077549' },
      ]);
      expect(plan.resolved).toHaveLength(2);
    });

    it('attaches to an existing product of that name instead of creating a second one', () => {
      const plan = planDecisions([add({ newProductName: 'Cheese (unspecified)' })], CAT);
      expect(plan.newProducts).toEqual([]);
      expect(plan.resolved[0]).toMatchObject({ productId: 'p-cheese', via: 'ADD_EXISTING' });
      expect(plan.adoptedExisting[0]).toMatchObject({ stockCode: 'CHEE-UNSP-ONE' });
    });

    it('refuses a placeholder rather than creating a product called UNKNOWN', () => {
      const plan = planDecisions([add({ newProductName: 'UNKNOWN - "4 x 2.5kg" (check invoice)' })], CAT);
      expect(plan.newProducts).toEqual([]);
      expect(plan.refusals[0]!.reason).toContain('placeholder');
    });

    it('refuses a unit outside the allow-list, so "kgs" cannot become a fourth unit', () => {
      const plan = planDecisions([add({ newStockUom: 'kgs' })], CAT);
      expect(plan.refusals[0]!.reason).toContain('kgs');
      expect(plan.newProducts).toEqual([]);
    });

    it('refuses two rows that name one product in two different units', () => {
      const plan = planDecisions(
        [add({ supplierSku: 'A', newStockUom: 'kg' }), add({ supplierSku: 'B', newStockUom: 'l' })],
        CAT,
      );
      expect(plan.newProducts).toHaveLength(1);
      expect(plan.refusals).toHaveLength(1);
      expect(plan.refusals[0]!.reason).toContain('two units');
    });

    it('refuses a name two live products share instead of picking one', () => {
      const plan = planDecisions([add({ newProductName: 'Mint' })], CAT);
      expect(plan.resolved).toEqual([]);
      expect(plan.refusals[0]!.reason).toContain('more than one live product');
    });

    it('will not mint a code a live product already holds', () => {
      const plan = planDecisions([add({ newProductName: 'Self Raising Flourish' })], CAT);
      expect(plan.newProducts[0]!.stockCode).not.toBe('SELF-RASG-FLOR');
    });

    it('will not mint a slug a soft-deleted product still occupies', () => {
      // (company, slug) is unique and ignores deleted_at, so a name freed by
      // the duplicate merge is still taken.
      const plan = planDecisions([add({ newProductName: 'Sprinkletti Party' })], CAT, ['SPRI-PART']);
      expect(plan.newProducts[0]!.stockCode).toBe('SPRI-PART-2');
      expect(plan.newProducts[0]!.slug).toBe('spri-part-2');
    });
  });

  it('reports every refusal in one pass so a run can be abandoned before it writes', () => {
    const plan = planDecisions(
      [
        row(),
        row({ supplierSku: 'bad-1', decision: 'NOPE' }),
        row({ supplierSku: 'bad-2', decision: 'ADD ITEM', newProductName: 'TBC', newStockUom: 'kg' }),
      ],
      CAT,
    );
    expect(plan.refusals).toHaveLength(2);
    expect(plan.resolved).toHaveLength(1);
  });
});
