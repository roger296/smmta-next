/**
 * Drop-ship supplier admin routes.
 *
 *   GET  /api/v1/suppliers-dropship                — list (drop-ship-aware)
 *   GET  /api/v1/suppliers-dropship/:id            — detail + recent poll log
 *   POST /api/v1/suppliers-dropship/:id/test       — test connection
 *   POST /api/v1/suppliers-dropship/:id/poll-now   — trigger a one-off poll
 *   GET  /api/v1/suppliers-dropship/:id/poll-log   — paginated poll-log
 *   GET  /api/v1/products/:id/supplier-mappings    — per-product mappings
 *   PUT  /api/v1/products/:id/supplier-mappings    — bulk upsert
 *
 * The basic supplier CRUD lives at /api/v1/suppliers (existing PO
 * supplier routes); these endpoints add the drop-ship-specific bits
 * without disturbing the PO surface.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { suppliers, supplierPollLog, supplierProducts } from '../../db/schema/index.js';
import { requireAuth } from '../../shared/middleware/auth.js';
import {
  dropshipSupplierSchema,
  testConnectionSchema,
  upsertSupplierMappingsSchema,
} from '../purchasing/supplier.schema.js';
import { DropshipSupplierService } from './supplier-dropship.service.js';
import { runSupplierPoll } from '../../workers/supplier-poll.worker.js';
import { resolveConnector } from '../../integrations/suppliers/registry.js';

const idParamSchema = z.object({ id: z.string().uuid() });

const service = new DropshipSupplierService();

/** Strip the encrypted api key from any row before returning it. */
function publicSupplier(s: typeof suppliers.$inferSelect) {
  const { apiKeyEnc, ...rest } = s;
  void apiKeyEnc;
  return { ...rest, hasApiKey: !!apiKeyEnc };
}

export async function dropshipSupplierRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // GET /suppliers-dropship — list every supplier (drop-ship + PO).
  app.get('/suppliers-dropship', async () => {
    const db = getDb();
    const rows = await db.query.suppliers.findMany({
      where: isNull(suppliers.deletedAt),
      orderBy: (s, { asc }) => [asc(s.name)],
    });
    return { success: true, data: rows.map(publicSupplier) };
  });

  // GET /suppliers-dropship/:id — detail with last 30 poll-log rows.
  app.get('/suppliers-dropship/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const db = getDb();
    const supplier = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, id), isNull(suppliers.deletedAt)),
    });
    if (!supplier) {
      return reply.status(404).send({ success: false, error: 'Supplier not found' });
    }
    const logs = await db.query.supplierPollLog.findMany({
      where: eq(supplierPollLog.supplierId, id),
      orderBy: [desc(supplierPollLog.startedAt)],
      limit: 30,
    });
    const mappingCount = (await db
      .select({ id: supplierProducts.id })
      .from(supplierProducts)
      .where(
        and(eq(supplierProducts.supplierId, id), isNull(supplierProducts.deletedAt)),
      )).length;
    return {
      success: true,
      data: {
        supplier: publicSupplier(supplier),
        recentPollLog: logs,
        mappingCount,
      },
    };
  });

  // PATCH-like update of the drop-ship integration columns. Body uses
  // `apiKeyPlaintext` for the operator-supplied raw key; we encrypt
  // it before persisting. Empty/missing means "leave existing key".
  app.put('/suppliers-dropship/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const parsed = dropshipSupplierSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid body', issues: parsed.error.issues });
    }
    const db = getDb();
    const supplier = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, id), isNull(suppliers.deletedAt)),
    });
    if (!supplier) {
      return reply.status(404).send({ success: false, error: 'Supplier not found' });
    }

    const updates: Partial<typeof suppliers.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.slug !== undefined) updates.slug = parsed.data.slug;
    if (parsed.data.connectorKind !== undefined) updates.connectorKind = parsed.data.connectorKind;
    if (parsed.data.apiBaseUrl !== undefined) updates.apiBaseUrl = parsed.data.apiBaseUrl;
    if (parsed.data.apiAuthScheme !== undefined) updates.apiAuthScheme = parsed.data.apiAuthScheme;
    if (parsed.data.isDropshipActive !== undefined) updates.isDropshipActive = parsed.data.isDropshipActive;
    if (parsed.data.pollIntervalMinutes !== undefined) updates.pollIntervalMinutes = parsed.data.pollIntervalMinutes;
    if (parsed.data.dispatchSlaMinDays !== undefined) updates.dispatchSlaMinDays = parsed.data.dispatchSlaMinDays;
    if (parsed.data.dispatchSlaMaxDays !== undefined) updates.dispatchSlaMaxDays = parsed.data.dispatchSlaMaxDays;
    if (parsed.data.showSupplierNameToCustomers !== undefined) updates.showSupplierNameToCustomers = parsed.data.showSupplierNameToCustomers;
    if (parsed.data.apiKeyPlaintext) {
      updates.apiKeyEnc = service.encryptApiKey(parsed.data.apiKeyPlaintext);
    }
    const [row] = await db.update(suppliers).set(updates).where(eq(suppliers.id, id)).returning();
    return { success: true, data: publicSupplier(row!) };
  });

  // POST /suppliers-dropship/:id/test — calls connector.getStockAndPrice
  // with whatever sku the operator typed.
  app.post('/suppliers-dropship/:id/test', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const parsed = testConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Invalid body' });
    }
    const db = getDb();
    const supplier = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, id), isNull(suppliers.deletedAt)),
    });
    if (!supplier) {
      return reply.status(404).send({ success: false, error: 'Supplier not found' });
    }
    try {
      const connector = resolveConnector(supplier);
      const r = await connector.getStockAndPrice([parsed.data.supplierSku]);
      return { success: true, data: { ok: true, snapshots: r } };
    } catch (err) {
      return reply.status(200).send({
        success: true,
        data: { ok: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  // POST /suppliers-dropship/:id/poll-now — queue a one-off poll for
  // this supplier only. Runs synchronously inline (the SPA waits and
  // shows the result); for a long catalogue this is fine because the
  // worker chunks at 100 SKUs.
  app.post('/suppliers-dropship/:id/poll-now', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const outcomes = await runSupplierPoll({ onlySupplierId: id, ignoreCadence: true });
    return reply.send({ success: true, data: outcomes });
  });

  // GET /suppliers-dropship/:id/poll-log — paginated.
  app.get('/suppliers-dropship/:id/poll-log', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const db = getDb();
    const rows = await db.query.supplierPollLog.findMany({
      where: eq(supplierPollLog.supplierId, id),
      orderBy: [desc(supplierPollLog.startedAt)],
      limit: 200,
    });
    return { success: true, data: rows };
  });

  // GET /products/:id/supplier-mappings — list mappings for one product.
  app.get('/products/:id/supplier-mappings', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const db = getDb();
    const rows = await db.query.supplierProducts.findMany({
      where: and(
        eq(supplierProducts.productId, id),
        isNull(supplierProducts.deletedAt),
      ),
      orderBy: (sp, { asc }) => [asc(sp.priority), asc(sp.createdAt)],
    });
    return reply.send({ success: true, data: rows });
  });

  // PUT /products/:id/supplier-mappings — bulk upsert.
  app.put('/products/:id/supplier-mappings', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const parsed = upsertSupplierMappingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Invalid body', issues: parsed.error.issues });
    }
    const db = getDb();
    const existing = await db.query.supplierProducts.findMany({
      where: and(
        eq(supplierProducts.productId, id),
        isNull(supplierProducts.deletedAt),
      ),
    });
    const existingBySupplier = new Map(existing.map((r) => [r.supplierId, r]));
    const requestedSupplierIds = new Set(parsed.data.mappings.map((m) => m.supplierId));

    // Determine the singleton companyId from any existing supplier or
    // the singleton helper. Since this is single-tenant, all rows share
    // the same companyId.
    const { getSingletonCompanyId } = await import('../../shared/auth/company.js');
    const companyId = getSingletonCompanyId();

    for (const m of parsed.data.mappings) {
      const e = existingBySupplier.get(m.supplierId);
      if (e) {
        await db
          .update(supplierProducts)
          .set({
            supplierSku: m.supplierSku,
            costGbp: m.costGbp,
            priority: m.priority,
            isActive: m.isActive,
            updatedAt: new Date(),
          })
          .where(eq(supplierProducts.id, e.id));
      } else {
        await db.insert(supplierProducts).values({
          companyId,
          productId: id,
          supplierId: m.supplierId,
          supplierSku: m.supplierSku,
          costGbp: m.costGbp,
          priority: m.priority,
          isActive: m.isActive,
        });
      }
    }
    // Soft-delete any previous mapping not present in the request.
    for (const e of existing) {
      if (!requestedSupplierIds.has(e.supplierId)) {
        await db
          .update(supplierProducts)
          .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(supplierProducts.id, e.id));
      }
    }
    const refreshed = await db.query.supplierProducts.findMany({
      where: and(
        eq(supplierProducts.productId, id),
        isNull(supplierProducts.deletedAt),
      ),
      orderBy: (sp, { asc }) => [asc(sp.priority), asc(sp.createdAt)],
    });
    return reply.send({ success: true, data: refreshed });
  });

  // GET /health/supplier-poll — per-supplier health snapshot.
  app.get('/health/supplier-poll', async () => {
    const db = getDb();
    const list = await db.query.suppliers.findMany({
      where: and(eq(suppliers.isDropshipActive, true), isNull(suppliers.deletedAt)),
    });
    const out = [] as Array<{
      supplierId: string;
      slug: string | null;
      lastPollAt: Date | null;
      minutesSinceLastPoll: number | null;
      status: 'ok' | 'stale' | 'failing' | 'never-polled';
    }>;
    for (const s of list) {
      const last = await db.query.supplierPollLog.findFirst({
        where: eq(supplierPollLog.supplierId, s.id),
        orderBy: [desc(supplierPollLog.startedAt)],
      });
      const at = last?.finishedAt ?? null;
      const mins = at ? (Date.now() - at.getTime()) / 60_000 : null;
      let status: 'ok' | 'stale' | 'failing' | 'never-polled';
      if (s.lastError) status = 'failing';
      else if (!at) status = 'never-polled';
      else if (mins !== null && mins > s.pollIntervalMinutes * 2) status = 'stale';
      else status = 'ok';
      out.push({
        supplierId: s.id,
        slug: s.slug,
        lastPollAt: at,
        minutesSinceLastPoll: mins !== null ? Math.round(mins) : null,
        status,
      });
    }
    return { success: true, data: out };
  });
}
