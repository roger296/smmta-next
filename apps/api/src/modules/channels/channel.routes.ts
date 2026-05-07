/**
 * Channel reference + per-product channel rules.
 *
 *   GET  /api/v1/channels                     — reference list
 *   GET  /api/v1/products/:id/channels        — full matrix for one product
 *   PUT  /api/v1/products/:id/channels        — bulk upsert
 *
 * The full matrix is also embedded into `GET /api/v1/products/:id` (see
 * product.routes.ts) so the admin SPA can render the channels section
 * without a second round-trip.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { products } from '../../db/schema/index.js';
import { requireAuth } from '../../shared/middleware/auth.js';
import { ChannelService } from './channel.service.js';

const idParamSchema = z.object({ id: z.string().uuid() });

const upsertRulesBodySchema = z.object({
  channels: z
    .array(
      z.object({
        channelId: z.string().uuid(),
        isOffered: z.boolean(),
        priceOverrideGbp: z
          .union([
            z.string().regex(/^\d+(\.\d{1,2})?$/, 'priceOverrideGbp must be a decimal string'),
            z.null(),
          ])
          .nullable()
          .optional(),
      }),
    )
    .min(1)
    .max(100),
});

const service = new ChannelService();

export async function channelRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/channels', async () => {
    const data = await service.listActive();
    return { success: true, data };
  });

  app.get('/products/:id/channels', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const db = getDb();
    const product = await db.query.products.findFirst({
      where: eq(products.id, id),
      columns: { id: true, minSellingPrice: true },
    });
    if (!product) {
      return reply.status(404).send({ success: false, error: 'Product not found' });
    }
    const data = await service.getRulesForProduct(id, product.minSellingPrice ?? '0');
    return { success: true, data };
  });

  app.put('/products/:id/channels', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const parsed = upsertRulesBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const db = getDb();
    const product = await db.query.products.findFirst({
      where: eq(products.id, id),
      columns: { id: true, minSellingPrice: true },
    });
    if (!product) {
      return reply.status(404).send({ success: false, error: 'Product not found' });
    }
    await service.upsertRulesForProduct(
      id,
      parsed.data.channels.map((c) => ({
        channelId: c.channelId,
        isOffered: c.isOffered,
        priceOverrideGbp: c.priceOverrideGbp ?? null,
      })),
    );
    const data = await service.getRulesForProduct(id, product.minSellingPrice ?? '0');
    return { success: true, data };
  });
}
