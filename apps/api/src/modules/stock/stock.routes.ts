/**
 * Per-site stock ledger API (P4, spec §A5).
 *
 *   GET  /api/v1/stock-levels            — on-hand per (product, site)
 *   GET  /api/v1/stock-levels/valuation  — WAC valuation per site / item kind
 *   GET  /api/v1/stock-levels/low        — items at/below reorder point
 *   POST /api/v1/stock-levels/adjust     — manual ADJUSTMENT movement
 *   POST /api/v1/stock-levels/transfer   — inter-site transfer (paired legs)
 *
 * These operate on the auditable movement ledger (on-hand = running sum).
 * Serial/batch-tracked discrete goods keep using the warehouse-based
 * /stock-items endpoints (DECISIONS D4).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { StockLevelService } from './stock-level.service.js';
import { StockQueryService } from './stock-query.service.js';

const levelService = new StockLevelService();
const queryService = new StockQueryService();

const listQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  itemKind: z.enum(['MERCH', 'RETAIL', 'INGREDIENT', 'PACKAGING']).optional(),
  lowOnly: z.coerce.boolean().optional(),
});

const valuationQuerySchema = z.object({ siteId: z.string().uuid().optional() });

const adjustSchema = z.object({
  productId: z.string().uuid(),
  siteId: z.string().uuid(),
  qtyDelta: z.coerce.number().refine((v) => v !== 0, 'qtyDelta must be non-zero'),
  unitCost: z.coerce.number().min(0).optional(),
  idempotencyKey: z.string().max(200).optional(),
});

const transferSchema = z.object({
  productId: z.string().uuid(),
  fromSiteId: z.string().uuid(),
  toSiteId: z.string().uuid(),
  qty: z.coerce.number().positive(),
  unitCost: z.coerce.number().min(0).optional(),
  idempotencyKey: z.string().max(200).optional(),
});

const reorderSchema = z.object({
  entries: z
    .array(
      z.object({
        productId: z.string().uuid(),
        siteId: z.string().uuid(),
        reorderPoint: z.coerce.number().min(0).nullable().optional(),
        reorderUpTo: z.coerce.number().min(0).nullable().optional(),
        minDaysCover: z.coerce.number().int().min(0).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

export async function stockRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/stock-levels', async (request) => {
    const q = listQuerySchema.parse(request.query);
    const data = await queryService.listLevels(q);
    return { success: true, data };
  });

  app.get('/stock-levels/valuation', async (request) => {
    const q = valuationQuerySchema.parse(request.query);
    const data = await queryService.valuation(q);
    return { success: true, data };
  });

  app.get('/stock-levels/low', async (request) => {
    const q = valuationQuerySchema.parse(request.query);
    const data = await queryService.lowStock(q);
    return { success: true, data };
  });

  app.put('/stock-levels/reorder', async (request, reply) => {
    const parsed = reorderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    for (const e of parsed.data.entries) {
      await levelService.setReorderParams(e);
    }
    return { success: true, data: { updated: parsed.data.entries.length } };
  });

  app.post('/stock-levels/adjust', async (request, reply) => {
    const parsed = adjustSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await levelService.adjust(parsed.data);
    return { success: true, data };
  });

  app.post('/stock-levels/transfer', async (request, reply) => {
    const parsed = transferSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    if (parsed.data.fromSiteId === parsed.data.toSiteId) {
      return reply
        .status(400)
        .send({ success: false, error: 'source and destination sites must differ' });
    }
    const data = await levelService.transfer({
      productId: parsed.data.productId,
      fromSiteId: parsed.data.fromSiteId,
      toSiteId: parsed.data.toSiteId,
      qty: parsed.data.qty,
      unitCost: parsed.data.unitCost,
      sourceKey: parsed.data.idempotencyKey,
    });
    return { success: true, data };
  });
}
