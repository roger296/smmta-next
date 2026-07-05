/**
 * Public "coming soon" catalogue (SPEC F8). Storefront-read gated. Lists
 * prospective products still open for interest, with the live flag count +
 * threshold so the storefront can render the group-buy progress bar.
 */
import type { FastifyInstance } from 'fastify';
import { apiKeyAuth } from '../../shared/middleware/api-key.js';
import { InterestFlagService } from './interest.service.js';

const service = new InterestFlagService();

export async function comingSoonRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:read']));

  app.get('/storefront/coming-soon', async (_request, reply) => {
    return reply.send({ success: true, data: await service.listComingSoon() });
  });
}
