/**
 * Reorder suggestions / proposed orders API (P7, spec §A7).
 *
 *   GET  /api/v1/reorder/proposals              — list (filter by status/site)
 *   POST /api/v1/reorder/proposals/:id/approve  — approve a PROPOSED proposal
 *   POST /api/v1/reorder/proposals/:id/place    — place (email PO / connector)
 *   PATCH /api/v1/reorder/proposals/:id         — edit suggested qty
 *   POST /api/v1/reorder/sweep                  — run the daily sweep now
 *
 * JWT-gated.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { ReorderService } from './reorder.service.js';
import { runReorderSweep } from './reorder.sweep.js';

const idParamSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({
  status: z.enum(['PROPOSED', 'APPROVED', 'PLACED', 'EMAILED', 'REJECTED', 'CANCELLED']).optional(),
  siteId: z.string().uuid().optional(),
});
const updateSchema = z.object({ qtyPurchase: z.coerce.number().positive() });

const service = new ReorderService();

export async function reorderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/reorder/proposals', async (request) => {
    const q = listQuerySchema.parse(request.query);
    const data = await service.list(q);
    return { success: true, data };
  });

  app.post('/reorder/proposals/:id/approve', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const data = await service.approve(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Proposal not found or not PROPOSED' });
    return { success: true, data };
  });

  app.post('/reorder/proposals/:id/place', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const data = await service.place(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Proposal not found' });
    return { success: true, data };
  });

  app.patch('/reorder/proposals/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await service.updateQty(id, parsed.data.qtyPurchase);
    if (!data) return reply.status(404).send({ success: false, error: 'Proposal not found' });
    return { success: true, data };
  });

  app.post('/reorder/sweep', async () => {
    const data = await runReorderSweep();
    return { success: true, data };
  });
}
