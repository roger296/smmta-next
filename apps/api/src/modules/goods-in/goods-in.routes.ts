/**
 * Goods-in API (P8, spec §A7).
 *
 *   POST /api/v1/goods-in              — book in a delivery (idempotent)
 *   POST /api/v1/goods-in/:id/reverse  — reverse a receipt (site_manager+)
 *   GET  /api/v1/goods-in              — list receipts (optional site filter)
 *   GET  /api/v1/goods-in/:id          — one receipt + lines
 *   GET  /api/v1/goods-in/expected     — orders a venue is still waiting on
 *   GET  /api/v1/purchase-orders/:id/receiving
 *                                      — one order laid out for booking in:
 *                                        ordered / received / outstanding per
 *                                        line, and the receipts so far
 *
 * Booking against an order: POST /goods-in with `purchaseOrderId`, each line
 * naming its `purchaseOrderLineId`. Book any subset of lines and any part of
 * a line; the rest stays outstanding. More than is outstanding, or an item not
 * on the order, is refused with 409 OVER_DELIVERY and the list, unless the
 * booking sends `acceptOverDelivery: true`.
 *
 * JWT-gated. The iPad goods-in screen (P13) submits to POST /goods-in.
 *
 * Role split (Aug-2026 feedback, E-4; locked decision 5): a `head_baker` may
 * book a delivery in; reversing one is `site_manager`+. The site guard is
 * E-1's belt to the site-binding braces — a PIN bound to London South cannot
 * produce a booking recorded against Birmingham whatever the client sends.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccessSite, getAuthUser, requireAuth } from '../../shared/middleware/auth.js';
import { requireBoundSite, requireRole } from '../../shared/middleware/require-role.js';
import {
  GoodsInPurchaseOrderError,
  GoodsInReversalError,
  GoodsInService,
  OverDeliveryError,
} from './goods-in.service.js';
import { openOrdersForSite, receivingView } from './po-receiving.service.js';

const receiveSchema = z.object({
  siteId: z.string().uuid(),
  supplierId: z.string().uuid().nullable().optional(),
  reorderProposalId: z.string().uuid().nullable().optional(),
  purchaseOrderId: z.string().uuid().nullable().optional(),
  deliveryNoteNumber: z.string().max(100).nullable().optional(),
  acceptOverDelivery: z.boolean().optional(),
  reference: z.string().max(200).optional(),
  idempotencyKey: z.string().min(1).max(200),
  deliveryCharge: z.coerce.number().min(0).optional(),
  photoRefs: z.array(z.object({ url: z.string(), sku: z.string().optional(), capturedAt: z.string().optional() })).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        qtyPurchase: z.coerce.number().positive(),
        unitCost: z.coerce.number().min(0).optional(),
        batchCode: z.string().max(100).optional(),
        useBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        purchaseOrderLineId: z.string().uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

const reverseSchema = z.object({
  reason: z.string().max(500).nullable().optional(),
});

const listQuerySchema = z.object({ siteId: z.string().uuid().optional() });
const expectedQuerySchema = z.object({ siteId: z.string().uuid() });
const idParamSchema = z.object({ id: z.string().uuid() });

const service = new GoodsInService();

export async function goodsInRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post(
    '/goods-in',
    {
      preHandler: [
        requireRole(['head_baker', 'site_manager']),
        requireBoundSite((request) => (request.body as { siteId?: string } | undefined)?.siteId),
      ],
    },
    async (request, reply) => {
      const parsed = receiveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
      }
      try {
        const data = await service.receive(parsed.data);
        return reply.status(data.alreadyExisted ? 200 : 201).send({ success: true, data });
      } catch (err) {
        if (err instanceof OverDeliveryError) {
          return reply
            .status(409)
            .send({ success: false, error: err.message, code: 'OVER_DELIVERY', overDelivery: err.lines });
        }
        if (err instanceof GoodsInPurchaseOrderError) {
          return reply.status(err.statusCode).send({ success: false, error: err.message });
        }
        throw err;
      }
    },
  );

  app.get('/goods-in/expected', async (request, reply) => {
    const parsed = expectedQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'siteId is required' });
    const user = getAuthUser(request);
    if (user && !canAccessSite(user, parsed.data.siteId)) {
      return reply.status(403).send({ success: false, error: 'You are not signed in to that venue.' });
    }
    return { success: true, data: await openOrdersForSite(parsed.data.siteId) };
  });

  app.get('/purchase-orders/:id/receiving', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const data = await receivingView(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Purchase order not found' });
    const user = getAuthUser(request);
    if (user && data.site && !canAccessSite(user, data.site.id)) {
      return reply.status(403).send({ success: false, error: 'That order is for another venue.' });
    }
    return { success: true, data };
  });

  app.post(
    '/goods-in/:id/reverse',
    { preHandler: requireRole(['site_manager']) },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const parsed = reverseSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
      }
      const user = getAuthUser(request);
      try {
        const data = await service.reverse({
          receiptId: id,
          reason: parsed.data.reason ?? null,
          userId: user?.userId ?? null,
        });
        if (!data) return reply.status(404).send({ success: false, error: 'Receipt not found' });
        return reply.status(data.alreadyExisted ? 200 : 201).send({ success: true, data });
      } catch (err) {
        if (err instanceof GoodsInReversalError) {
          return reply.status(409).send({ success: false, error: err.message });
        }
        throw err;
      }
    },
  );

  app.get('/goods-in', async (request) => {
    const q = listQuerySchema.parse(request.query);
    const data = await service.list(q);
    return { success: true, data };
  });

  app.get('/goods-in/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const data = await service.get(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Receipt not found' });
    return { success: true, data };
  });
}
