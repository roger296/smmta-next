/**
 * Public storefront read endpoints.
 *
 * Mounted at `/api/v1/storefront/*`. Every route is gated by
 * `apiKeyAuth(['storefront:read'])`. Bodies omit operational fields (cost,
 * supplier, marketplace identifiers, etc.) and include only `is_published = true`
 * rows.
 *
 * Responses set `Cache-Control: public, max-age=30, stale-while-revalidate=60`
 * so the storefront RSC layer and any edge cache can re-use payloads.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyAuth, getApiKeyContext } from '../../shared/middleware/api-key.js';
import { CatalogueService } from './catalogue.service.js';
import { OrderCommitService } from './order-commit.service.js';
import {
  InsufficientStockError,
  ReservationService,
} from './reservation.service.js';

const CACHE_HEADER = 'public, max-age=30, stale-while-revalidate=60';

const productIdsQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(z.string().uuid()).min(1).max(100)),
});

const slugParamSchema = z.object({
  slug: z.string().min(1).max(200),
});

const service = new CatalogueService();

export async function storefrontReadRoutes(app: FastifyInstance) {
  // All routes require an api key with storefront:read scope.
  app.addHook('preHandler', apiKeyAuth(['storefront:read']));

  // GET /storefront/groups — published groups + thin variants
  app.get(
    '/storefront/groups',
    {
      schema: {
        tags: ['storefront'],
        summary: 'List published product groups for the storefront',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const data = await service.listGroups(ctx.companyId);
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data });
    },
  );

  // GET /storefront/groups/:slug — full group + full variants
  app.get(
    '/storefront/groups/:slug',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Get a single published group by slug',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { slug } = slugParamSchema.parse(request.params);
      const group = await service.getGroupBySlug(ctx.companyId, slug);
      if (!group) {
        return reply.status(404).send({ success: false, error: 'Group not found' });
      }
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data: group });
    },
  );

  // GET /storefront/products?ids=<csv> — batch lookup for cart price snapshots
  // (registered before /storefront/products/:slug so Fastify's path matching
  // resolves the static path first).
  app.get(
    '/storefront/products',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Batch-fetch published products by id (cart price snapshots)',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const parsed = productIdsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Missing or invalid ids parameter' });
      }
      const data = await service.getProductsByIds(ctx.companyId, parsed.data.ids);
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data });
    },
  );

  // GET /storefront/products/:slug — single product (works for standalone
  // and grouped products alike).
  app.get(
    '/storefront/products/:slug',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Get a single published product by slug',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { slug } = slugParamSchema.parse(request.params);
      const product = await service.getProductBySlug(ctx.companyId, slug);
      if (!product) {
        return reply.status(404).send({ success: false, error: 'Product not found' });
      }
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data: product });
    },
  );
}

// ===========================================================================
// Write surface — gated by `storefront:write`.
// Reservations + order commit + status + cancellation. See Prompt 5 of
// `buldmeawebstore.md`. Storefront read endpoints stay on `storefront:read`.
// ===========================================================================

const reservationItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(99),
});

const createReservationBodySchema = z.object({
  items: z.array(reservationItemSchema).min(1).max(50),
  ttlSeconds: z.number().int().min(60).max(60 * 60).optional(),
});

const addressSchema = z.object({
  line1: z.string().min(1).max(255),
  line2: z.string().max(255).optional(),
  city: z.string().min(1).max(100),
  region: z.string().max(100).optional(),
  postCode: z.string().min(1).max(50),
  country: z.string().min(1).max(50),
  contactName: z.string().max(100).optional(),
});

const commitOrderBodySchema = z.object({
  reservationId: z.string().uuid(),
  customer: z.object({
    email: z.string().email().max(100),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    phone: z.string().max(50).optional(),
  }),
  deliveryAddress: addressSchema,
  invoiceAddress: addressSchema.optional(),
  mollie: z.object({
    paymentId: z.string().min(1).max(100),
    amount: z.string().regex(/^\d+(\.\d{2})?$/, 'amount must be a major-unit string like "24.50"'),
    currency: z.string().length(3),
    methodPaid: z.string().min(1).max(50),
    status: z.string().min(1).max(50),
  }),
  deliveryCharge: z
    .string()
    .regex(/^\d+(\.\d{2})?$/, 'deliveryCharge must be a major-unit string')
    .optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const reservationService = new ReservationService();
const commitService = new OrderCommitService();

export async function storefrontWriteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:write']));

  // POST /storefront/reservations
  app.post(
    '/storefront/reservations',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Reserve stock for a basket prior to payment',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const parsed = createReservationBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
      }
      try {
        const result = await reservationService.createReservation(ctx.companyId, {
          items: parsed.data.items,
          ttlSeconds: parsed.data.ttlSeconds ?? 15 * 60,
        });
        return reply.status(201).send({
          success: true,
          data: {
            reservationId: result.reservationId,
            expiresAt: result.expiresAt.toISOString(),
            lines: result.lines,
          },
        });
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          return reply.status(409).send({
            success: false,
            error: 'INSUFFICIENT_STOCK',
            productId: err.productId,
            available: err.available,
            requested: err.requested,
          });
        }
        throw err;
      }
    },
  );

  // DELETE /storefront/reservations/:id  → 204 (idempotent)
  app.delete(
    '/storefront/reservations/:id',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Release a held reservation early',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { id } = idParamSchema.parse(request.params);
      await reservationService.releaseReservation(id, ctx.companyId);
      return reply.status(204).send();
    },
  );

  // POST /storefront/orders — commit the reservation into a confirmed order.
  app.post(
    '/storefront/orders',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Commit a reservation into a confirmed order (idempotent)',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
        return reply
          .status(400)
          .send({ success: false, error: 'Idempotency-Key header is required (≥ 8 chars)' });
      }
      const parsed = commitOrderBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
      }

      const { status, body } = await commitService.commitOrder(
        ctx.companyId,
        idempotencyKey,
        parsed.data,
      );
      return reply.status(status).send(body);
    },
  );

  // GET /storefront/orders/:id — public-safe order projection.
  app.get(
    '/storefront/orders/:id',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Fetch a customer-safe order projection',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { id } = idParamSchema.parse(request.params);
      const order = await commitService.getPublicOrder(ctx.companyId, id);
      if (!order) {
        return reply.status(404).send({ success: false, error: 'Order not found' });
      }
      return reply.send({ success: true, data: order });
    },
  );

  // POST /storefront/orders/:id/cancel
  app.post(
    '/storefront/orders/:id/cancel',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Cancel an order if it has not yet shipped',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { id } = idParamSchema.parse(request.params);
      const result = await commitService.cancelOrder(ctx.companyId, id);
      if (!result.ok && result.error === 'NOT_FOUND') {
        return reply.status(404).send({ success: false, error: 'Order not found' });
      }
      if (!result.ok) {
        return reply.status(409).send({
          success: false,
          error: 'NOT_CANCELLABLE',
          currentStatus: result.currentStatus,
        });
      }
      return reply.send({ success: true, data: { status: result.status } });
    },
  );
}
