/**
 * Interest-flag routes (SPEC F8). Storefront-facing, gated by the storefront
 * api-key. The contextual button posts here; anonymous users supply an email
 * (server captures the user + flag_updates consent).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyAuth } from '../../shared/middleware/api-key.js';
import { InterestFlagService } from './interest.service.js';

const service = new InterestFlagService();

const createSchema = z
  .object({
    userId: z.string().uuid().optional(),
    email: z.string().email().optional(),
    sku: z.string().optional(),
    prospectiveId: z.string().uuid().optional(),
    flagType: z.enum(['restock', 'offers', 'register_interest']),
    sourcePage: z.string().max(200).optional(),
  })
  .refine((v) => v.userId || v.email, { message: 'userId or email required' })
  .refine((v) => v.sku || v.prospectiveId, { message: 'sku or prospectiveId required' });

export async function interestRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:write']));

  app.post('/storefront/interest', async (request, reply) => {
    const input = createSchema.parse(request.body);
    const result = await service.createInterestFlag(input);
    return reply.status(201).send({ success: true, data: result });
  });

  app.post('/storefront/interest/:flagId/clear', async (request, reply) => {
    const { flagId } = z.object({ flagId: z.string().uuid() }).parse(request.params);
    await service.clearFlag(flagId);
    return reply.send({ success: true });
  });

  app.get('/storefront/interest/:userId', async (request, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const data = await service.listInterests(userId);
    return reply.send({ success: true, data });
  });
}
