/**
 * Prospective-product admin routes (SPEC F8, §5.2). JWT-gated. The operator
 * creates + curates the "coming soon" catalogue that customers register
 * interest in.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { InterestFlagService } from './interest.service.js';

const service = new InterestFlagService();

export async function prospectiveRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/admin/prospective', async () => ({ success: true, data: await service.listProspectiveAdmin() }));

  app.post('/admin/prospective', async (request, reply) => {
    const input = z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        interestThreshold: z.number().int().positive().optional(),
        creatorPartner: z.string().optional(),
      })
      .parse(request.body);
    const data = await service.createProspective(input);
    return reply.status(201).send({ success: true, data });
  });

  app.patch('/admin/prospective/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const patch = z
      .object({
        status: z.enum(['considering', 'group_buy_open', 'ordered', 'ranged', 'abandoned']).optional(),
        interestThreshold: z.number().int().positive().optional(),
      })
      .parse(request.body);
    const data = await service.updateProspective(id, patch);
    if (!data) return reply.status(404).send({ success: false, error: 'not found' });
    return reply.send({ success: true, data });
  });
}
