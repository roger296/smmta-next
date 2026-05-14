/**
 * Chunked query helper.
 *
 * Postgres caps the number of bind parameters per statement at 65,535
 * (the wire-protocol limit). Drizzle's `inArray(col, ids)` builds an
 * `IN ($1, $2, ..., $n)` clause, so passing 100k IDs blows up with:
 *
 *   bind message has 65xxx parameter formats but 0 parameters
 *
 * After importing the full Ralawise catalogue we hit this in three
 * storefront queries (`availableQtyMap`, `channelDecisionMap`,
 * `getVariantAvailabilityBatch`). This helper splits the input array
 * into chunks small enough to fit comfortably under the limit and
 * concatenates the results.
 *
 * Default chunk size is 20,000. Each query also binds the other
 * WHERE-clause params (companyId, status enum, etc.) plus driver
 * overhead, so leaving 45k+ params of headroom keeps us safe.
 */

const DEFAULT_CHUNK_SIZE = 20_000;

/**
 * Call `fetch(chunk)` over the input ids in batches, return the
 * flattened rows in order. Safe for any array length, including
 * empty (returns empty immediately, no round-trip).
 */
export async function chunkedQuery<R>(
  ids: readonly string[],
  fetch: (chunk: string[]) => Promise<R[]>,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<R[]> {
  if (ids.length === 0) return [];
  if (ids.length <= chunkSize) return fetch(ids as string[]);
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize) as string[];
    // eslint-disable-next-line no-await-in-loop
    const rows = await fetch(chunk);
    out.push(...rows);
  }
  return out;
}
