/**
 * Image captures API (P23, spec §A10) — AI groundwork.
 *
 *   GET  /api/v1/image-captures        — gallery (filter by product/site/source)
 *   POST /api/v1/image-captures        — record one capture (e.g. a reference photo)
 *
 * JWT-gated. Backs the admin gallery; the stub MCP tools read the same set.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { ImageCaptureService } from './image-capture.service.js';

const sourceEnum = z.enum(['REFERENCE', 'GOODS_IN', 'STOCK_TAKE', 'CONSUMPTION', 'SHELF']);

const galleryQuerySchema = z.object({
  productId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  source: sourceEnum.optional(),
});

const recordSchema = z.object({
  productId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
  source: sourceEnum.default('REFERENCE'),
  imageRef: z.string().min(1).max(1000),
  label: z.string().max(200).nullable().optional(),
  sourceRef: z.string().max(200).nullable().optional(),
});

const service = new ImageCaptureService();

export async function imageCaptureRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/image-captures', async (request) => {
    const q = galleryQuerySchema.parse(request.query);
    return { success: true, data: await service.gallery(q) };
  });

  app.post('/image-captures', async (request, reply) => {
    const parsed = recordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await service.record(parsed.data);
    return reply.status(201).send({ success: true, data });
  });
}
