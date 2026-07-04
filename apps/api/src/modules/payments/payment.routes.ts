/**
 * Pre-order payment routes (SPEC §16).
 *  - Storefront (api-key): place a pre-order, cancel-before-dispatch.
 *  - Admin (JWT): mark a manual transfer paid.
 *  - Webhook (public, thin): ACK 200 fast, then normalise (§4.7). In production
 *    the normalise step is enqueued to the worker; here it runs inline after the
 *    ACK for a single-instance deploy.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { apiKeyAuth } from '../../shared/middleware/api-key.js';
import { PreorderService, PaymentMethodNotAllowedError } from './preorder.service.js';

const preorders = new PreorderService();

const createSchema = z.object({
  userId: z.string().uuid(),
  items: z
    .array(
      z.object({ sku: z.string().min(1), qty: z.number().int().positive(), poolRef: z.string().min(1) }),
    )
    .min(1),
  paymentMethod: z.enum(['bank', 'manual_transfer', 'card', 'wallet', 'paypal']).optional(),
});

export async function preorderStorefrontRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:write']));

  app.post('/storefront/preorders', async (request, reply) => {
    const input = createSchema.parse(request.body);
    try {
      const order = await preorders.createPreorder(input);
      return reply.status(201).send({ success: true, data: order });
    } catch (err) {
      if (err instanceof PaymentMethodNotAllowedError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      throw err;
    }
  });

  app.get('/storefront/preorders/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const order = await preorders.getOrder(id);
    if (!order) return reply.status(404).send({ success: false, error: 'not found' });
    return { success: true, data: order };
  });

  app.post('/storefront/preorders/:id/cancel', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await preorders.cancel(id);
    return reply.send({ success: true });
  });
}

export async function preorderAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/admin/preorders/:id/mark-paid', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await preorders.markPaid(id);
    return reply.send({ success: true });
  });
}

export async function mollieWebhookRoutes(app: FastifyInstance) {
  // Thin webhook: Mollie POSTs only { id }. ACK 200 immediately, then normalise.
  app.post('/webhooks/mollie', async (request, reply) => {
    const body = z.object({ id: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return reply.status(200).send('ok'); // never make Mollie retry on our parse
    // Fire-and-normalise; the handler is idempotent so a duplicate webhook is safe.
    preorders.handleWebhook(body.data.id).catch((err) => {
      request.log.error({ err, id: body.data.id }, 'mollie webhook normalise failed');
    });
    return reply.status(200).send('ok');
  });
}
