/**
 * The order feed: how another system hands orders to this one and asks
 * how they are getting on. Authenticated by an API key, not a login, so a
 * warehouse client's own software (or a shop platform we have no
 * connector for) can post to it unattended.
 *
 *   POST /order-feed/orders               scope orders:write
 *   GET  /order-feed/orders/:reference    scope orders:read
 *
 * The body is the same normalised order the CSV importer and the
 * marketplace connectors produce, so every route into the system creates
 * orders the same way. The sender's own reference is the key: posting it
 * twice returns the order made the first time rather than a second order.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { orderLines } from '../../db/schema/index.js';
import { apiKeyAuth, getApiKeyContext } from '../../shared/middleware/api-key.js';
import { MarketplaceService } from '../../integrations/marketplace/marketplace.service.js';
import type { MarketplaceOrder } from '../../integrations/marketplace/marketplace.types.js';

const addressSchema = z.object({
  contactName: z.string().max(100).optional(),
  phone: z.string().max(50).optional(),
  line1: z.string().max(255).optional(),
  line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postCode: z.string().max(50).optional(),
  country: z.string().max(50).optional(),
});

export const orderFeedOrderSchema = z.object({
  /** The sender's own id for the order; must be unique per sender. */
  reference: z.string().min(1).max(100),
  /** yyyy-mm-dd. Today when absent. */
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  customer: z.object({
    name: z.string().min(1).max(200),
    email: z.string().email().max(255).optional(),
    phone: z.string().max(50).optional(),
  }),
  deliveryAddress: addressSchema,
  invoiceAddress: addressSchema.optional(),
  lines: z
    .array(
      z.object({
        /** Our stock code or the product's EAN. */
        sku: z.string().min(1).max(100),
        quantity: z.coerce.number().positive(),
        unitPrice: z.coerce.number().min(0),
        /** Percentage. 20 when absent. */
        taxRate: z.coerce.number().min(0).max(100).default(20),
      }),
    )
    .min(1),
  deliveryCharge: z.coerce.number().min(0).default(0),
  taxInclusive: z.boolean().default(false),
  currencyCode: z.string().length(3).default('GBP'),
  courierName: z.string().max(100).optional(),
  /** The warehouse to fulfil from, by name. */
  warehouseName: z.string().max(200).optional(),
  paymentMethod: z.string().max(100).optional(),
  /** Anything the sender wants kept with the order, returned untouched. */
  metadata: z.record(z.unknown()).optional(),
});

export type OrderFeedOrderInput = z.infer<typeof orderFeedOrderSchema>;

/** The feed's body as the importer's normalised order. */
export function toMarketplaceOrder(input: OrderFeedOrderInput): MarketplaceOrder {
  return {
    thirdPartyOrderId: input.reference,
    sourceChannel: 'API',
    customer: input.customer,
    deliveryAddress: { ...input.deliveryAddress, phone: input.deliveryAddress.phone ?? input.customer.phone },
    invoiceAddress: input.invoiceAddress,
    orderDate: input.orderDate ?? new Date().toISOString().slice(0, 10),
    currencyCode: input.currencyCode,
    deliveryCharge: input.deliveryCharge,
    taxInclusive: input.taxInclusive,
    paymentMethod: input.paymentMethod,
    customerOrderNumber: input.reference,
    courierName: input.courierName,
    warehouseName: input.warehouseName,
    rawData: input.metadata,
    lines: input.lines.map((l) => ({
      sku: l.sku,
      name: l.sku,
      quantity: l.quantity,
      pricePerUnit: l.unitPrice,
      taxRate: l.taxRate,
    })),
  };
}

const marketplaceService = new MarketplaceService();

export async function orderFeedRoutes(app: FastifyInstance) {
  app.post(
    '/order-feed/orders',
    {
      preHandler: apiKeyAuth(['orders:write']),
      schema: { tags: ['order-feed'], summary: 'Create an order from an external system' },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const parsed = orderFeedOrderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
      }

      const existing = await marketplaceService.findByReference(ctx.companyId, parsed.data.reference);
      if (existing) {
        return reply.status(200).send({
          success: true,
          duplicate: true,
          data: { reference: parsed.data.reference, orderId: existing.id, orderNumber: existing.orderNumber, status: existing.status },
        });
      }

      const result = await marketplaceService.importOrders(ctx.companyId, `api-key:${ctx.keyId}`, [
        toMarketplaceOrder(parsed.data),
      ]);
      const created = result.orders[0];
      if (!created) {
        return reply.status(422).send({
          success: false,
          error: result.errors[0]?.error ?? 'Order was not created',
        });
      }
      return reply.status(201).send({
        success: true,
        duplicate: false,
        data: { reference: created.thirdPartyOrderId, orderId: created.orderId, orderNumber: created.orderNumber, status: 'CONFIRMED' },
      });
    },
  );

  app.get(
    '/order-feed/orders/:reference',
    {
      preHandler: apiKeyAuth(['orders:read']),
      schema: { tags: ['order-feed'], summary: "An order's progress, by the sender's reference" },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { reference } = request.params as { reference: string };
      const order = await marketplaceService.findByReference(ctx.companyId, reference);
      if (!order) return reply.status(404).send({ success: false, error: 'Order not found' });

      const lines = await getDb().query.orderLines.findMany({
        where: and(eq(orderLines.orderId, order.id), isNull(orderLines.deletedAt)),
        with: { product: { columns: { stockCode: true } } },
      });

      return {
        success: true,
        data: {
          reference,
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          orderDate: order.orderDate,
          shippedDate: order.shippedDate,
          courierName: order.courierName,
          trackingNumber: order.trackingNumber,
          trackingLink: order.trackingLink,
          lines: lines.map((l) => ({
            sku: l.product?.stockCode ?? null,
            quantity: l.quantity,
            shipped: l.numberShipped ?? 0,
          })),
        },
      };
    },
  );
}
