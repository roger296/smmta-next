/**
 * Shared catalogue API (P11, spec §A4).
 *
 *   POST /api/v1/catalogue/import     — import BumbleBee products (idempotent)
 *   POST /api/v1/catalogue/sync       — push the slim subset (dry-run by default)
 *   POST /api/v1/catalogue/reconcile  — gaps vs a BumbleBee id list
 *
 * JWT-gated.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { CatalogueSyncService } from './catalogue-sync.service.js';

const importSchema = z.object({
  products: z
    .array(
      z.object({
        bumblebeeProductId: z.string().min(1).max(100),
        name: z.string().min(1).max(500),
        productType: z.string().max(50).nullable().optional(),
        costPrice: z.union([z.coerce.number(), z.string()]).nullable().optional(),
        defaultSalePrice: z.union([z.coerce.number(), z.string()]).nullable().optional(),
        sku: z.string().max(100).nullable().optional(),
      }),
    )
    .min(1)
    .max(5000),
});

const reconcileSchema = z.object({
  bumblebeeProductIds: z.array(z.string()).max(10000).default([]),
});

const service = new CatalogueSyncService();

export async function catalogueSyncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/catalogue/import', async (request, reply) => {
    const parsed = importSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await service.importProducts(parsed.data.products);
    return { success: true, data };
  });

  app.post('/catalogue/sync', async () => {
    const data = await service.pushSlimSubset();
    return { success: true, data };
  });

  app.post('/catalogue/reconcile', async (request, reply) => {
    const parsed = reconcileSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await service.reconcile(parsed.data.bumblebeeProductIds);
    return { success: true, data };
  });
}
