/**
 * Subscription routes (SPEC F4). Storefront-api-key gated: signup (establishes
 * the mandate via a first payment), skip/pause/resume, and applying credit at
 * checkout. The storefront account UI (apps/store) is Prompt 14.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyAuth } from '../../shared/middleware/api-key.js';
import { SubscriptionService } from './subscription.service.js';

const subs = new SubscriptionService();

export async function subscriptionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:write']));

  app.post('/storefront/subscriptions/signup', async (request, reply) => {
    const { userId, plan } = z
      .object({ userId: z.string().uuid(), plan: z.enum(['starter', 'pro']) })
      .parse(request.body);
    const data = await subs.signup(userId, plan);
    return reply.status(201).send({ success: true, data });
  });

  app.post('/storefront/subscriptions/:id/pause', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await subs.pause(id);
    return reply.send({ success: true });
  });

  app.post('/storefront/subscriptions/:id/resume', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await subs.resume(id);
    return reply.send({ success: true });
  });

  app.post('/storefront/subscriptions/apply-credit', async (request, reply) => {
    const { userId, amountPence } = z
      .object({ userId: z.string().uuid(), amountPence: z.number().int().positive() })
      .parse(request.body);
    const data = await subs.applyCredit(userId, amountPence);
    return reply.send({ success: true, data });
  });
}
