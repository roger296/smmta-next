/**
 * Supplier-stock-and-price polling worker.
 *
 * Walks every active drop-ship supplier, decides whether enough time has
 * passed since `lastPolledAt` to warrant a new poll (per-supplier
 * cadence), then asks the connector for current stock + cost-price
 * snapshots and writes the results to `supplier_products` /
 * `suppliers.lastError` / `supplier_poll_log`.
 *
 * Concurrency: a `pg_advisory_lock(hash(supplierId))` per supplier
 * means a slow run never overlaps with the next one. If the lock is
 * already held, the worker silently skips that supplier.
 *
 * Failure handling (per-chunk, not per-run):
 *   - SupplierAuthError → fail the whole run immediately; bump
 *                  `consecutiveFailures`. After 5 consecutive failures
 *                  set `isDropshipActive = false`. (Credentials don't
 *                  recover mid-run, so continuing would just thrash
 *                  the API.)
 *   - 5xx / 429 / network / bad-request on a single chunk → skip that
 *                  chunk, keep going. Successful chunks have already
 *                  been persisted, so a transient blip in 1 of 4,000
 *                  Ralawise requests no longer trashes the whole 8-hour
 *                  poll cycle.
 *   - Partial-success run → record the last chunk error on
 *                  `suppliers.lastError` as a breadcrumb but RESET
 *                  consecutiveFailures (partial success counts as
 *                  recovery; next cycle retries the failed chunks).
 *   - All chunks failed → treat as whole-supplier failure (preserves
 *                  the disable-after-5 safety net).
 *
 * Stale-snapshot policy: a SKU whose chunk failed this cycle is left
 * with its existing snapshot untouched — better stale-but-known data
 * than blanking the row on a brief outage. Only SKUs whose chunk
 * SUCCEEDED but were absent from the supplier's response get marked
 * `sku_not_found`.
 *
 * Entry point: `runSupplierPoll(opts?)` — called from the CLI script
 * `apps/api/scripts/run-supplier-poll.ts`, which is invoked by the
 * systemd timer.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, getPool } from '../config/database.js';
import {
  supplierPollLog,
  supplierProducts,
  suppliers,
} from '../db/schema/index.js';
import { resolveConnector } from '../integrations/suppliers/registry.js';
import { SupplierAuthError } from '../integrations/suppliers/errors.js';
import type { SupplierConnector, SupplierStockSnapshot } from '../integrations/suppliers/types.js';

const DEFAULT_STOCK_CHUNK_SIZE = 100;
const FAILURE_DISABLE_THRESHOLD = 5;

// Mutable so the integration tests can use a smaller chunk size with
// fewer seeded products to exercise the multi-chunk failure paths.
// Production code never calls the setter; the module-level default
// stands.
let stockChunkSize = DEFAULT_STOCK_CHUNK_SIZE;
/** @internal — tests only. */
export function setStockChunkSizeForTests(n: number): void {
  stockChunkSize = n > 0 ? n : DEFAULT_STOCK_CHUNK_SIZE;
}
/** @internal — tests only. */
export function resetStockChunkSizeForTests(): void {
  stockChunkSize = DEFAULT_STOCK_CHUNK_SIZE;
}

export interface RunSupplierPollOptions {
  /** Only poll the supplier with this id (skipping cadence checks).
   *  Used by the admin SPA's "Poll now" button. */
  onlySupplierId?: string;
  /** Override the connector resolver — passed through for tests. */
  resolveConnector?: (supplier: typeof suppliers.$inferSelect) => SupplierConnector;
  /** Hook fired before each supplier; tests use this to stub the
   *  connector via `registerStubConnectorForTests`. */
  onBeforeSupplier?: (supplier: typeof suppliers.$inferSelect) => void;
  /** Skip the per-supplier cadence check — equivalent to setting
   *  `lastPolledAt = null` for every product. */
  ignoreCadence?: boolean;
}

export interface SupplierPollOutcome {
  supplierId: string;
  supplierSlug: string;
  productsChecked: number;
  productsUpdated: number;
  errorMessage: string | null;
  skippedBecause?: 'recently-polled' | 'lock-held' | 'inactive' | 'no-connector';
}

export async function runSupplierPoll(
  opts: RunSupplierPollOptions = {},
): Promise<SupplierPollOutcome[]> {
  const db = getDb();
  const allSuppliers = opts.onlySupplierId
    ? await db.query.suppliers.findMany({
        where: and(
          eq(suppliers.id, opts.onlySupplierId),
          isNull(suppliers.deletedAt),
        ),
      })
    : await db.query.suppliers.findMany({
        where: and(
          eq(suppliers.isDropshipActive, true),
          isNull(suppliers.deletedAt),
        ),
      });

  const outcomes: SupplierPollOutcome[] = [];
  for (const supplier of allSuppliers) {
    const outcome = await pollOneSupplier(supplier, opts);
    outcomes.push(outcome);
  }
  return outcomes;
}

async function pollOneSupplier(
  supplier: typeof suppliers.$inferSelect,
  opts: RunSupplierPollOptions,
): Promise<SupplierPollOutcome> {
  const supplierId = supplier.id;
  const slug = supplier.slug ?? supplierId;
  const db = getDb();

  if (!supplier.isDropshipActive && !opts.onlySupplierId) {
    return { supplierId, supplierSlug: slug, productsChecked: 0, productsUpdated: 0, errorMessage: null, skippedBecause: 'inactive' };
  }
  if (supplier.connectorKind === 'NONE' || !supplier.apiBaseUrl || !supplier.apiKeyEnc) {
    return { supplierId, supplierSlug: slug, productsChecked: 0, productsUpdated: 0, errorMessage: null, skippedBecause: 'no-connector' };
  }

  // Acquire the per-supplier advisory lock. If something else is
  // already polling, skip silently.
  const pool = getPool();
  const client = await pool.connect();
  let acquired = false;
  try {
    const lockResult = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)::int) AS pg_try_advisory_lock',
      [supplierId],
    );
    acquired = lockResult.rows[0]?.pg_try_advisory_lock === true;
    if (!acquired) {
      return { supplierId, supplierSlug: slug, productsChecked: 0, productsUpdated: 0, errorMessage: null, skippedBecause: 'lock-held' };
    }

    // Cadence check (unless we're told to ignore it).
    if (!opts.ignoreCadence && !opts.onlySupplierId) {
      const mostRecent = await db
        .select({ at: sql<Date | null>`MAX(${supplierProducts.lastPolledAt})` })
        .from(supplierProducts)
        .where(
          and(
            eq(supplierProducts.supplierId, supplierId),
            isNull(supplierProducts.deletedAt),
          ),
        );
      const lastAt = mostRecent[0]?.at ? new Date(mostRecent[0].at) : null;
      if (lastAt) {
        const minutesAgo = (Date.now() - lastAt.getTime()) / 60_000;
        if (minutesAgo < supplier.pollIntervalMinutes) {
          return {
            supplierId,
            supplierSlug: slug,
            productsChecked: 0,
            productsUpdated: 0,
            errorMessage: null,
            skippedBecause: 'recently-polled',
          };
        }
      }
    }

    // Insert the poll-log row up front so the admin SPA sees the
    // run-in-progress.
    const [logRow] = await db
      .insert(supplierPollLog)
      .values({
        companyId: supplier.companyId,
        supplierId,
        productsChecked: 0,
        productsUpdated: 0,
      })
      .returning();
    const logId = logRow!.id;

    // Resolve the connector. opts.resolveConnector is the test override;
    // production goes through the registry.
    let connector: SupplierConnector;
    try {
      opts.onBeforeSupplier?.(supplier);
      connector = opts.resolveConnector ? opts.resolveConnector(supplier) : resolveConnector(supplier);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'connector resolve failed';
      await markSupplierFailure(supplier, msg);
      await db
        .update(supplierPollLog)
        .set({ finishedAt: new Date(), errorMessage: msg })
        .where(eq(supplierPollLog.id, logId));
      return { supplierId, supplierSlug: slug, productsChecked: 0, productsUpdated: 0, errorMessage: msg };
    }

    const mappings = await db.query.supplierProducts.findMany({
      where: and(
        eq(supplierProducts.supplierId, supplierId),
        eq(supplierProducts.isActive, true),
        isNull(supplierProducts.deletedAt),
      ),
    });
    const productsChecked = mappings.length;

    if (mappings.length === 0) {
      await db.update(suppliers).set({ lastError: null, consecutiveFailures: 0, updatedAt: new Date() }).where(eq(suppliers.id, supplierId));
      await db
        .update(supplierPollLog)
        .set({ finishedAt: new Date(), productsChecked: 0, productsUpdated: 0 })
        .where(eq(supplierPollLog.id, logId));
      return { supplierId, supplierSlug: slug, productsChecked: 0, productsUpdated: 0, errorMessage: null };
    }

    const skuToMapping = new Map<string, typeof supplierProducts.$inferSelect>();
    for (const m of mappings) skuToMapping.set(m.supplierSku, m);
    const skus = [...skuToMapping.keys()];
    const chunkSize = stockChunkSize;
    const totalChunks = Math.ceil(skus.length / chunkSize);

    // Per-chunk error tolerance.
    //
    // The supplier-poll worker used to hold every snapshot in memory
    // and apply DB updates only after the entire SKU list had been
    // fetched. A single 429 / 5xx / network timeout anywhere in that
    // run lost EVERY snapshot already collected, even when most of the
    // catalogue had come back fine. For Ralawise — ~96k SKUs polled
    // across ~4.4k group-level HTTP calls per cycle — that meant one
    // transient hiccup in 4,400 chances killed the whole 8-hour poll
    // and the storefront kept showing stale OOS state.
    //
    // The new shape:
    //   - chunk loop is the outer structure; each chunk has its own
    //     try/catch
    //   - successful chunks persist immediately (the next chunk's
    //     failure can't undo them)
    //   - transient errors (5xx / 429 / network / bad-request on a
    //     single chunk) increment a counter and continue; the next
    //     chunk gets its shot
    //   - SupplierAuthError still fails fast — credentials don't
    //     recover within a run and continuing would just thrash the API
    //   - all-chunks-failed → mark whole-supplier failure (keeps the
    //     consecutiveFailures → disable behaviour for genuinely-broken
    //     suppliers)
    //   - some-but-not-all chunks failed → store the last error on the
    //     supplier row as a breadcrumb but reset consecutiveFailures
    //     (partial success counts as recovery — next cycle retries
    //     the failed chunks)
    let productsUpdated = 0;
    let chunksOk = 0;
    let chunksFailed = 0;
    let lastChunkError: string | null = null;
    const seen = new Set<string>();

    for (let i = 0; i < skus.length; i += chunkSize) {
      const chunk = skus.slice(i, i + chunkSize);
      let result: SupplierStockSnapshot[];
      try {
        result = await connector.getStockAndPrice(chunk);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'chunk error';
        // Auth errors are fatal for the whole run — the token's
        // credentials aren't going to start working halfway through.
        if (err instanceof SupplierAuthError) {
          await markSupplierFailure(supplier, msg);
          await db
            .update(supplierPollLog)
            .set({ finishedAt: new Date(), productsChecked, productsUpdated, errorMessage: msg })
            .where(eq(supplierPollLog.id, logId));
          return { supplierId, supplierSlug: slug, productsChecked, productsUpdated, errorMessage: msg };
        }
        // 5xx / 429 / network / per-chunk bad-request: skip and keep
        // going. Bad-request is treated as transient at the chunk
        // level because Ralawise occasionally 404s a whole group code
        // mid-poll — better to skip the chunk than to abandon the
        // remaining ~96k SKUs we still need.
        chunksFailed++;
        lastChunkError = msg;
        continue;
      }
      // Persist this chunk's snapshots before moving on — a later
      // chunk's failure can't lose this work.
      for (const s of result) {
        const m = skuToMapping.get(s.supplierSku);
        if (!m) continue;
        seen.add(s.supplierSku);
        if (s.stockQty === null && s.costGbp === null) {
          await db
            .update(supplierProducts)
            .set({
              lastKnownStock: null,
              lastPollError: 'sku_not_found',
              lastPolledAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(supplierProducts.id, m.id));
          continue;
        }
        await db
          .update(supplierProducts)
          .set({
            lastKnownStock: s.stockQty,
            lastKnownPrice: s.costGbp !== null ? s.costGbp.toFixed(2) : null,
            lastPolledAt: new Date(),
            lastPollError: null,
            updatedAt: new Date(),
          })
          .where(eq(supplierProducts.id, m.id));
        productsUpdated++;
      }
      // SKUs we asked the connector about that don't appear in its
      // response — supplier discontinued the variant. Mark sku_not_found
      // now (while we know which chunk they belonged to), not at the
      // end of the loop, otherwise a later chunk's failure would force
      // us to skip the post-loop pass and these mappings would be left
      // with stale snapshots.
      for (const sku of chunk) {
        if (seen.has(sku)) continue;
        const m = skuToMapping.get(sku);
        if (!m) continue;
        seen.add(sku);
        await db
          .update(supplierProducts)
          .set({
            lastKnownStock: null,
            lastPollError: 'sku_not_found',
            lastPolledAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(supplierProducts.id, m.id));
      }
      chunksOk++;
    }

    // Final outcome.
    if (chunksOk === 0 && chunksFailed > 0) {
      // Nothing recovered this run — count it as a whole-supplier
      // failure so the disable-after-5-consecutive-failures rule still
      // catches genuinely-broken suppliers.
      const msg = lastChunkError ?? 'all chunks failed';
      await markSupplierFailure(supplier, msg);
      await db
        .update(supplierPollLog)
        .set({ finishedAt: new Date(), productsChecked, productsUpdated, errorMessage: msg })
        .where(eq(supplierPollLog.id, logId));
      return { supplierId, supplierSlug: slug, productsChecked, productsUpdated, errorMessage: msg };
    }

    // Partial or full success.
    const partialErrMsg = chunksFailed > 0
      ? `${chunksFailed}/${totalChunks} chunks failed (last: ${(lastChunkError ?? 'unknown').slice(0, 200)})`
      : null;
    await db
      .update(suppliers)
      .set({ lastError: partialErrMsg, consecutiveFailures: 0, updatedAt: new Date() })
      .where(eq(suppliers.id, supplierId));
    await db
      .update(supplierPollLog)
      .set({ finishedAt: new Date(), productsChecked, productsUpdated, errorMessage: partialErrMsg })
      .where(eq(supplierPollLog.id, logId));

    return { supplierId, supplierSlug: slug, productsChecked, productsUpdated, errorMessage: partialErrMsg };
  } finally {
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1)::int)', [supplierId]);
      } catch {
        // best effort
      }
    }
    client.release();
  }
}

async function markSupplierFailure(
  supplier: typeof suppliers.$inferSelect,
  msg: string,
): Promise<void> {
  const db = getDb();
  const newCount = (supplier.consecutiveFailures ?? 0) + 1;
  const updates: Partial<typeof suppliers.$inferInsert> = {
    lastError: msg.slice(0, 1000),
    consecutiveFailures: newCount,
    updatedAt: new Date(),
  };
  if (newCount >= FAILURE_DISABLE_THRESHOLD) {
    updates.isDropshipActive = false;
  }
  await db.update(suppliers).set(updates).where(eq(suppliers.id, supplier.id));
}
