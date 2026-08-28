/**
 * Stock-item query schema.
 *
 * The stock list is the one place an operator looks up physical inventory, but
 * a stock row carries no searchable text of its own — the name, SKU and EAN all
 * live on the product. Without a search parameter the page offered only
 * warehouse and status filters, which is no use against a catalogue of any size.
 */
import { describe, expect, it } from 'vitest';
import { stockItemQuerySchema } from './stock-item.schema.js';

describe('stockItemQuerySchema', () => {
  it('accepts a free-text search term', () => {
    const q = stockItemQuerySchema.parse({ search: 'V3-PLA-REG-GREEN' });
    expect(q.search).toBe('V3-PLA-REG-GREEN');
  });

  it('leaves search undefined when absent, so the filter is skipped entirely', () => {
    expect(stockItemQuerySchema.parse({}).search).toBeUndefined();
  });

  it('still applies the shared pagination cap', () => {
    // The stock-adjust page requested 500 products and got a 400 it never
    // surfaced; the same cap governs this endpoint.
    expect(() => stockItemQuerySchema.parse({ pageSize: 500 })).toThrow();
    expect(stockItemQuerySchema.parse({ pageSize: 250 }).pageSize).toBe(250);
  });

  it('keeps the existing filters working alongside search', () => {
    const q = stockItemQuerySchema.parse({
      search: 'green',
      status: 'IN_STOCK',
      warehouseId: 'b39d25fe-43b0-429c-9933-3b20ed1301bf',
    });
    expect(q.status).toBe('IN_STOCK');
    expect(q.warehouseId).toBeTruthy();
  });
});
