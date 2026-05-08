/**
 * Admin supplier-orders dashboard endpoints (§F).
 *
 *   GET  /api/v1/supplier-orders                    — paginated list, filters
 *   GET  /api/v1/supplier-orders/:id                — drill-down (request +
 *                                                     response payloads)
 *   POST /api/v1/supplier-orders/:id/retry          — reset FAILED → PENDING
 *   POST /api/v1/supplier-orders/:id/cancel         — PENDING → CANCELLED
 *   POST /api/v1/supplier-orders/:id/mark-shipped   — manual transition for
 *                                                     out-of-band shipments
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { supplierOrders, suppliers } from '../../db/schema/index.js';
import { requireAuth } from '../../shared/middleware/auth.js';

const idParamSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  status: z
    .enum(['PENDING', 'PLACED', 'ACKNOWLEDGED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED'])
    .optional(),
  supplierId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const markShippedSchema = z.object({
  trackingCarrier: z.string().max(100).optional(),
  trackingNumber: z.string().max(200).optional(),
});

export async function supplierOrdersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/supplier-orders', async (request) => {
    const query = listQuerySchema.parse(request.query);
    const db = getDb();
    const conditions = [isNull(supplierOrders.deletedAt)];
    if (query.status) conditions.push(eq(supplierOrders.status, query.status));
    if (query.supplierId) conditions.push(eq(supplierOrders.supplierId, query.supplierId));
    const rows = await db.query.supplierOrders.findMany({
      where: and(...conditions),
      orderBy: [desc(supplierOrders.createdAt)],
      limit: query.limit,
    });
    return { success: true, data: rows };
  });

  app.get('/supplier-orders/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const db = getDb();
    const row = await db.query.supplierOrders.findFirst({
      where: and(eq(supplierOrders.id, id), isNull(supplierOrders.deletedAt)),
    });
    if (!row) return reply.status(404).send({ success: false, error: 'Not found' });
    const supplier = await db.query.suppliers.findFirst({
      where: eq(suppliers.id, row.supplierId),
    });
    return { success: true, data: { ...row, supplier } };
  });

  app.post('/supplier-orders/:id/retry', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const db = getDb();
    const row = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, id) });
    if (!row) return reply.status(404).send({ success: false, error: 'Not found' });
    if (row.status !== 'FAILED') {
      return reply.status(409).send({ success: false, error: `Only FAILED rows can be retried; current=${row.status}` });
    }
    await db
      .update(supplierOrders)
      .set({
        status: 'PENDING',
        retryCount: 0,
        nextRetryAt: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(supplierOrders.id, id));
    return { success: true };
  });

  app.post('/supplier-orders/:id/cancel', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const db = getDb();
    const row = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, id) });
    if (!row) return reply.status(404).send({ success: false, error: 'Not found' });
    if (row.status !== 'PENDING') {
      return reply
        .status(409)
        .send({ success: false, error: `Only PENDING rows can be cancelled; current=${row.status}` });
    }
    await db
      .update(supplierOrders)
      .set({ status: 'CANCELLED', updatedAt: new Date() })
      .where(eq(supplierOrders.id, id));
    return { success: true };
  });

  app.post('/supplier-orders/:id/mark-shipped', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const parsed = markShippedSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Invalid body' });
    }
    const db = getDb();
    const row = await db.query.supplierOrders.findFirst({ where: eq(supplierOrders.id, id) });
    if (!row) return reply.status(404).send({ success: false, error: 'Not found' });
    await db
      .update(supplierOrders)
      .set({
        status: 'SHIPPED',
        shippedAt: new Date(),
        trackingCarrier: parsed.data.trackingCarrier ?? row.trackingCarrier,
        trackingNumber: parsed.data.trackingNumber ?? row.trackingNumber,
        updatedAt: new Date(),
      })
      .where(eq(supplierOrders.id, id));
    return { success: true };
  });
}
