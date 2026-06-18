/**
 * Goods-in API (P8, spec §A7).
 *
 *   POST /api/v1/goods-in       — book in a delivery (idempotent)
 *   GET  /api/v1/goods-in       — list receipts (optional site filter)
 *   GET  /api/v1/goods-in/:id   — one receipt + lines
 *
 * JWT-gated. The iPad goods-in screen (P13) submits to POST /goods-in.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { GoodsInService } from './goods-in.service.js';

const receiveSchema = z.object({
  siteId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  reorderProposalId: z.string().uuid().nullable().optional(),
  reference: z.string().max(200).optional(),
  idempotencyKey: z.string().min(1).max(200),
  deliveryCharge: z.coerce.number().min(0).optional(),
  photoRefs: z.array(z.object({ url: z.string(), sku: z.string().optional(), capturedAt: z.string().optional() })).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        qtyPurchase: z.coerce.number().positive(),
        unitCost: z.coerce.number().min(0).optional(),
        batchCode: z.string().max(100).optional(),
        useBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

const listQuerySchema = z.object({ siteId: z.string().uuid().optional() });
const idParamSchema = z.object({ id: z.string().uuid() });

const service = new GoodsInService();

export async function goodsInRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/goods-in', async (request, reply) => {
    const parsed = receiveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await service.receive(parsed.data);
    return reply.status(data.alreadyExisted ? 200 : 201).send({ success: true, data });
  });

  app.get('/goods-in', async (request) => {
    const q = listQuerySchema.parse(request.query);
    const data = await service.list(q);
    return { success: true, data };
  });

  app.get('/goods-in/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const data = await service.get(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Receipt not found' });
    return { success: true, data };
  });
}
