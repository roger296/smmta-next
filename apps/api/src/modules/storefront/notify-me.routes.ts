/**
 * POST /api/v1/storefront/notify-me
 *
 * Public-but-api-key-gated endpoint. The storefront forwards a
 * customer's "notify me when back in stock" submission here. We
 * upsert into `stock_notifications` and (if requested) into
 * `newsletter_subscribers`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyAuth, getApiKeyContext } from '../../shared/middleware/api-key.js';
import { NotifyMeService } from './notify-me.service.js';

const bodySchema = z.object({
  productId: z.string().uuid(),
  email: z.string().email().max(320),
  subscribeToNewsletter: z.boolean().default(true),
});

const service = new NotifyMeService();

export async function notifyMeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:write']));

  app.post(
    '/storefront/notify-me',
    {
      schema: {
        tags: ['storefront'],
        summary: "Subscribe a customer to a 'back in stock' notification",
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          issues: parsed.error.issues,
        });
      }
      const result = await service.record(ctx.companyId, parsed.data);
      return reply.status(result.created ? 201 : 200).send({ success: true, data: { ok: true } });
    },
  );
}
