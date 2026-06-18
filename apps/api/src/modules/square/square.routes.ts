/**
 * Square sales → stock decrement API (P10, spec §A8).
 *
 *   POST /api/v1/square/decrement   — ingest sale lines (idempotent decrements)
 *   GET  /api/v1/square/item-map    — Square-item ↔ stock-SKU map
 *   PUT  /api/v1/square/item-map    — upsert map entries
 *   POST /api/v1/square/auto-match  — auto-match by barcode/ean
 *   GET  /api/v1/square/unmapped    — quarantined (unresolved) lines
 *
 * JWT-gated. The BumbleBee Square-order poll (P24 timer) posts to /decrement.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { SquareDecrementService } from './square-decrement.service.js';

const decrementSchema = z.object({
  lines: z
    .array(
      z.object({
        channelSlug: z.string().min(1).max(60),
        sourcePk: z.string().min(1).max(200),
        sourceLineRef: z.string().min(1).max(200),
        qty: z.coerce.number().positive(),
        productId: z.string().uuid().optional(),
        squareKey: z.string().max(200).optional(),
        siteId: z.string().uuid().optional(),
        siteCanonical: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(500),
});

const mapSchema = z.object({
  entries: z.array(z.object({ squareKey: z.string().min(1).max(200), productId: z.string().uuid() })).min(1),
});

const autoMatchSchema = z.object({
  entries: z.array(z.object({ squareKey: z.string().min(1).max(200), code: z.string().min(1).max(64) })).min(1),
});

const service = new SquareDecrementService();

export async function squareRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/square/decrement', async (request, reply) => {
    const parsed = decrementSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await service.ingestBatch(parsed.data.lines);
    return { success: true, data };
  });

  app.get('/square/item-map', async () => ({ success: true, data: await service.listMap() }));

  app.put('/square/item-map', async (request, reply) => {
    const parsed = mapSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const updated = await service.upsertMap(parsed.data.entries);
    return { success: true, data: { updated } };
  });

  app.post('/square/auto-match', async (request, reply) => {
    const parsed = autoMatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const matched = await service.autoMatchByBarcode(parsed.data.entries);
    return { success: true, data: { matched } };
  });

  app.get('/square/unmapped', async () => ({ success: true, data: await service.listUnmapped() }));
}
