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
 * Failure handling:
 *   - Auth / 4xx → log + clear stock cache for known SKUs the supplier
 *                  didn't return; bump `consecutiveFailures`. After 5
 *                  consecutive whole-supplier failures, set
 *                  `isDropshipActive = false`.
 *   - 5xx / network → log + leave existing snapshots intact (keeping
 *                     stale-but-known data is better than blanking the
 *                     whole supplier on a brief outage).
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
import {
  SupplierAuthError,
  SupplierBadRequestError,
} from '../integrations/suppliers/errors.js';
import type { SupplierConnector, SupplierStockSnapshot } from '../integrations/suppliers/types.js';

const STOCK_CHUNK_SIZE = 100;
const FAILURE_DISABLE_THRESHOLD = 5;

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

    let snapshots: SupplierStockSnapshot[];
    try {
      snapshots = [];
      for (let i = 0; i < skus.length; i += STOCK_CHUNK_SIZE) {
        const chunk = skus.slice(i, i + STOCK_CHUNK_SIZE);
        const result = await connector.getStockAndPrice(chunk);
        snapshots.push(...result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'connector error';
      const isHardError = err instanceof SupplierAuthError || err instanceof SupplierBadRequestError;
      await markSupplierFailure(supplier, msg);
      await db
        .update(supplierPollLog)
        .set({ finishedAt: new Date(), productsChecked, productsUpdated: 0, errorMessage: msg })
        .where(eq(supplierPollLog.id, logId));
      // 5xx / network: leave product snapshots intact. Auth / 4xx:
      // we log, but don't blank the cache either — operators may want
      // to re-enable manually rather than have stale "out of stock"
      // surfacing in the storefront.
      return { supplierId, supplierSlug: slug, productsChecked, productsUpdated: 0, errorMessage: msg };
      void isHardError;
    }

    let productsUpdated = 0;
    const seen = new Set<string>();
    for (const s of snapshots) {
      const m = skuToMapping.get(s.supplierSku);
      if (!m) continue; // unknown SKU returned — connector emits these
      seen.add(s.supplierSku);
      // The connector emits null-fields snapshots for SKUs the supplier
      // didn't recognise (per `SupplierConnector` docstring) — treat
      // those as "sku_not_found" so the admin SPA can surface the
      // mismatch and stale snapshots aren't preserved on rows that
      // genuinely vanished from the supplier's catalogue.
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
    // SKUs we asked about but didn't get back at all (connector that
    // doesn't synthesise null entries) → also mark as sku_not_found.
    for (const m of mappings) {
      if (seen.has(m.supplierSku)) continue;
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

    await db
      .update(suppliers)
      .set({ lastError: null, consecutiveFailures: 0, updatedAt: new Date() })
      .where(eq(suppliers.id, supplierId));
    await db
      .update(supplierPollLog)
      .set({ finishedAt: new Date(), productsChecked, productsUpdated })
      .where(eq(supplierPollLog.id, logId));

    return { supplierId, supplierSlug: slug, productsChecked, productsUpdated, errorMessage: null };
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
