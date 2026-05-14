import { describe, expect, it, vi } from 'vitest';
import { chunkedQuery } from './chunk.js';

describe('chunkedQuery', () => {
  it('returns [] for empty input without invoking fetch', async () => {
    const fetch = vi.fn();
    const out = await chunkedQuery([], fetch);
    expect(out).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes the whole array in one call when below the chunk size', async () => {
    const fetch = vi.fn(async (chunk: string[]) => chunk.map((id) => ({ id })));
    const ids = ['a', 'b', 'c'];
    const out = await chunkedQuery(ids, fetch, 10);
    expect(out).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(ids);
  });

  it('splits into chunks when above the chunk size', async () => {
    const fetch = vi.fn(async (chunk: string[]) => chunk.map((id) => ({ id })));
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const out = await chunkedQuery(ids, fetch, 2);
    // 5 ids ÷ 2 = 3 chunks (2 + 2 + 1)
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(1, ['a', 'b']);
    expect(fetch).toHaveBeenNthCalledWith(2, ['c', 'd']);
    expect(fetch).toHaveBeenNthCalledWith(3, ['e']);
    expect(out).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]);
  });

  it('flattens results from multiple chunks correctly', async () => {
    // Each chunk returns rows with NO 1:1 correspondence to ids (simulates
    // aggregate query, e.g. `SELECT product_id, count(*) GROUP BY product_id`
    // which may return fewer rows than ids passed in).
    const fetch = vi.fn(async (chunk: string[]) =>
      chunk.filter((id) => id.startsWith('a')).map((id) => ({ id, n: 1 })),
    );
    const ids = ['a1', 'b1', 'a2', 'b2', 'a3'];
    const out = await chunkedQuery(ids, fetch, 2);
    expect(out).toEqual([{ id: 'a1', n: 1 }, { id: 'a2', n: 1 }, { id: 'a3', n: 1 }]);
  });

  it('handles 100k ids (real-world size) without parameter-limit errors', async () => {
    const ids = Array.from({ length: 100_000 }, (_, i) => `id-${i}`);
    let totalSeen = 0;
    let maxChunk = 0;
    const fetch = vi.fn(async (chunk: string[]) => {
      totalSeen += chunk.length;
      maxChunk = Math.max(maxChunk, chunk.length);
      return [];
    });
    await chunkedQuery(ids, fetch);
    expect(totalSeen).toBe(100_000);
    // No chunk exceeds the default chunk size.
    expect(maxChunk).toBeLessThanOrEqual(20_000);
    // 100k / 20k = 5 chunks
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
