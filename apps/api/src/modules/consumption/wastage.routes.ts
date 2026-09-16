/**
 * Standalone wastage API (Sept-2026 user testing, item 7).
 *
 *   GET  /api/v1/wastage   — recent events for a venue
 *   POST /api/v1/wastage   — record wasted stock (site-scoped)
 *
 * JWT-gated; the new PWA Wastage screen drives these. A site-bound actor (a
 * head-baker PIN) may only record against its own venue.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { WastageService, WastageError, WASTAGE_REASONS } from './wastage.service.js';

const service = new WastageService();

const recordSchema = z.object({
  siteId: z.string().uuid(),
  productId: z.string().uuid(),
  qty: z.coerce.number().positive(),
  reason: z.string().min(1).max(200),
  note: z.string().max(2000).nullable().optional(),
  recordedBy: z.string().max(200).nullable().optional(),
  // Optional bake link. Kept optional deliberately — most waste is not part of
  // a bake, and making every dropped delivery box answer "which bake?" adds a
  // step to the commonest case.
  sessionId: z.string().max(200).nullable().optional(),
  bake: z.string().max(200).nullable().optional(),
  occurredAt: z.string().datetime().nullable().optional(),
  clientKey: z.string().min(1).max(200),
});

const listQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function wastageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** The reasons the form offers. Free text is still accepted on POST. */
  app.get('/wastage/reasons', async () => ({ success: true, data: WASTAGE_REASONS }));

  app.get('/wastage', async (request) => {
    const q = listQuerySchema.parse(request.query);
    return { success: true, data: await service.list(q) };
  });

  app.post('/wastage', async (request, reply) => {
    const parsed = recordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const user = getAuthUser(request);
    try {
      const data = await service.record(parsed.data, user);
      return reply.status(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof WastageError) {
        const forbidden = err.message === 'forbidden_site_scope';
        return reply
          .status(forbidden ? 403 : 400)
          .send({ success: false, error: err.message });
      }
      throw err;
    }
  });
}
