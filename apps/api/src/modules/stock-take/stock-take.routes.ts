/**
 * Stock-takes API (P9, spec §A6).
 *
 *   POST /api/v1/stock-takes              — open a take (snapshots book stock)
 *   GET  /api/v1/stock-takes              — list
 *   GET  /api/v1/stock-takes/:id          — take + lines
 *   POST /api/v1/stock-takes/:id/counts   — record counts (offline-tolerant)
 *   POST /api/v1/stock-takes/:id/approve  — true-up + post adjustment
 *
 * JWT-gated. The iPad stock-take screen (P13) drives these.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { StockTakeService } from './stock-take.service.js';

const openSchema = z.object({
  siteId: z.string().uuid(),
  scope: z.enum(['FULL', 'CATEGORY', 'ZONE', 'ITEM', 'CYCLE']).default('FULL'),
  scopeRef: z.string().max(200).nullable().optional(),
});

const countsSchema = z.object({
  counts: z
    .array(
      z.object({
        productId: z.string().uuid(),
        countedQty: z.coerce.number().min(0),
        countIdempotencyKey: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

const idParamSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  status: z.enum(['OPEN', 'APPROVED', 'CANCELLED']).optional(),
});

const service = new StockTakeService();

export async function stockTakeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/stock-takes', async (request, reply) => {
    const parsed = openSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await service.open(parsed.data);
    return reply.status(201).send({ success: true, data });
  });

  app.get('/stock-takes', async (request) => {
    const q = listQuerySchema.parse(request.query);
    const data = await service.list(q);
    return { success: true, data };
  });

  app.get('/stock-takes/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const data = await service.get(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Stock-take not found' });
    // Warnings travel with the take so the count screen can show them BEFORE
    // someone approves a write-off (defect D-2).
    return { success: true, data: { ...data, warnings: await service.varianceWarnings(id) } };
  });

  app.post('/stock-takes/:id/counts', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const parsed = countsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const recorded = await service.recordCounts(id, parsed.data.counts);
    return { success: true, data: { recorded } };
  });

  app.post('/stock-takes/:id/approve', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    // Read the warnings BEFORE approving — approval trues the ledger up, after
    // which the variance is zero and the warning has nothing left to point at.
    const warnings = await service.varianceWarnings(id);
    const data = await service.approve(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Stock-take not found' });
    return { success: true, data, warnings };
  });
}
