/**
 * Building the match-review file.
 *
 * Its job is to make 400-odd lookups into 400-odd ticks without ever making a
 * decision on the operator's behalf — so the tests are mostly about what it
 * refuses to fill in.
 */
import { describe, expect, it } from 'vitest';
import {
  buildReview, catalogueFromExport, suggestStockUom, toReviewCsv, REVIEW_HEADER,
} from './propose-invoice-sku-matches.js';
import type { CatalogueProduct } from '../src/modules/suppliers/invoice-sku-match.js';

const cat: CatalogueProduct[] = [
  { id: '1', stockCode: 'DAIR-UNSL-BUTR', name: 'Unsalted Butter' },
  { id: '2', stockCode: 'BAKE-CAST-SUGR', name: 'Caster Sugar' },
  { id: '3', stockCode: 'ORNG-JUCE', name: 'Orange Juice' },
  { id: '4', stockCode: 'ORNG', name: 'Orange' },
  { id: '5', stockCode: 'YELO', name: 'Yellow' },
];

const sku = (o: Partial<Record<string, string>>) => ({
  supplier: 'Brakes', supplier_sku: '11127', description: 'Wholesome Farms Unsalted Butter',
  pack_size: '40x250g', base_unit: 'kg', unit_cost_gbp: '58.51', lines_seen: '158', ...o,
}) as Record<string, string>;

describe('suggestStockUom', () => {
  it('keeps bulk units the invoice is sure about', () => {
    expect(suggestStockUom('kg')).toBe('kg');
    expect(suggestStockUom('L')).toBe('l');
  });

  /**
   * A venue counts CONTAINERS, not grams. `each` is what a counter actually
   * does, and extract-count-list.ts learned the same lesson: a wrong unit
   * silently corrupts every future count.
   */
  it('falls back to each for anything else, including nothing', () => {
    expect(suggestStockUom('')).toBe('each');
    expect(suggestStockUom('g')).toBe('each');
    expect(suggestStockUom('Sheets')).toBe('each');
  });
});

describe('buildReview', () => {
  it('proposes the obvious product and carries the invoice evidence', () => {
    const [r] = buildReview([sku({})], cat, new Set());
    expect(r).toMatchObject({
      supplier: 'Brakes',
      supplierSku: '11127',
      proposedProduct: 'Unsalted Butter',
      proposedStockCode: 'DAIR-UNSL-BUTR',
      linesSeen: 158,
      packSize: '40x250g',
    });
  });

  /** The whole design: it never decides. */
  it('leaves the decision column empty even when it is confident', () => {
    const [r] = buildReview([sku({})], cat, new Set());
    expect(r!.decision).toBe('');
  });

  it('offers the runners-up so a wrong first guess is one glance to fix', () => {
    const [r] = buildReview(
      [sku({ supplier_sku: '9', description: 'Brakes The Juice Orange' })],
      cat,
      new Set(),
    );
    expect(r!.proposedProduct).toBe('Orange Juice');
    expect(r!.alternatives).toContain('Orange');
  });

  /**
   * The catalogue has a colouring product literally called "Yellow". A row
   * with no plausible product must still appear — that is the ADD ITEM /
   * NOT STOCK decision, and skipping it is how an item stays unorderable
   * with nobody knowing why.
   */
  it('includes a code with no candidate at all, ready for ADD ITEM or NOT STOCK', () => {
    const [r] = buildReview(
      [sku({ supplier_sku: 'B07TCN', description: 'Vytronix Powerful Electric Pressure Washer 1400W' })],
      cat,
      new Set(),
    );
    expect(r).toBeDefined();
    expect(r!.proposedStockCode).toBe('');
    expect(r!.decision).toBe('');
    // Not defaulted to ADD ITEM — that is how a catalogue fills with pressure washers.
    expect(r!.newProductName).toBe('Vytronix Powerful Electric Pressure Washer 1400W');
  });

  it('drops a code that is already mapped', () => {
    const mapped = new Set(['brakes::11127']);
    expect(buildReview([sku({})], cat, mapped)).toHaveLength(0);
  });

  it('drops a code the importer would place on its own', () => {
    // Exact name match — import-invoice-skus.ts takes this without review.
    const rows = buildReview([sku({ description: 'Unsalted Butter' })], cat, new Set());
    expect(rows).toHaveLength(0);
  });

  it('puts the busiest codes first, because it is a work list', () => {
    const rows = buildReview(
      [
        sku({ supplier_sku: 'A', description: 'Rare Thing', lines_seen: '2' }),
        sku({ supplier_sku: 'B', description: 'Common Thing', lines_seen: '158' }),
      ],
      cat,
      new Set(),
    );
    expect(rows.map((r) => r.supplierSku)).toEqual(['B', 'A']);
  });

  it('suggests a new-product name and unit for the ADD ITEM case', () => {
    const [r] = buildReview(
      [sku({ supplier_sku: 'X', description: 'Some New Syrup', base_unit: 'L' })],
      cat,
      new Set(),
    );
    expect(r!.newProductName).toBe('Some New Syrup');
    expect(r!.newStockUom).toBe('l');
  });
});

describe('toReviewCsv', () => {
  it('writes the agreed header', () => {
    expect(toReviewCsv([]).trim()).toBe(REVIEW_HEADER.join(','));
  });

  it('quotes a description containing commas, as most of them do', () => {
    const rows = buildReview(
      [sku({ supplier_sku: 'X', description: 'Deskit Laminating Pouches A4, Glossy, 120 Sheets' })],
      cat,
      new Set(),
    );
    const csv = toReviewCsv(rows);
    expect(csv).toContain('"Deskit Laminating Pouches A4, Glossy, 120 Sheets"');
    expect(csv.trim().split('\n')).toHaveLength(2);
  });
});

describe('catalogueFromExport', () => {
  it('reads the Products page export, BOM and all', () => {
    const csv = '﻿Product ID,Name,Stock code\nabc,Unsalted Butter,DAIR-UNSL-BUTR\n';
    expect(catalogueFromExport(csv)).toEqual([
      { id: 'abc', stockCode: 'DAIR-UNSL-BUTR', name: 'Unsalted Butter' },
    ]);
  });

  it('ignores a row with no name, which can match nothing', () => {
    expect(catalogueFromExport('Product ID,Name,Stock code\nabc,,X\n')).toEqual([]);
  });
});
