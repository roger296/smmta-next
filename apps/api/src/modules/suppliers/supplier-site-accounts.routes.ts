/**
 * Supplier accounts per venue (supplier-ordering groundwork, plan §3.2).
 *
 *   GET /api/v1/suppliers/:id/site-accounts           every active venue, with
 *                                                     this supplier's account and
 *                                                     when an order now arrives
 *   PUT /api/v1/suppliers/:id/site-accounts/:siteId   create / update (admin)
 *
 * Writes are head office only: a wrong cut-off or delivery day quietly makes
 * every order for that venue "arrive" on the wrong day.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { requireRole } from '../../shared/middleware/require-role.js';
import { WEEKDAYS } from './delivery-calendar.js';
import {
  SiteNotFoundError,
  SupplierNotFoundError,
  SupplierSiteAccountService,
} from './supplier-site-accounts.service.js';

const params = z.object({ id: z.string().uuid() });
const siteParams = z.object({ id: z.string().uuid(), siteId: z.string().uuid() });

const money = z.number().nonnegative().max(1_000_000).nullable().optional();
const text = (max: number) => z.string().max(max).nullable().optional();

export const siteAccountBody = z
  .object({
    accountNumber: text(60),
    ediLocationId: text(60),
    deliveryDays: z
      .array(z.string().transform((d) => d.toUpperCase()).pipe(z.enum(WEEKDAYS)))
      .max(7)
      .optional(),
    cutoffTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Cut-off must be a 24-hour time, e.g. 16:00')
      .nullable()
      .optional()
      .or(z.literal('').transform(() => null)),
    cutoffDaysBefore: z.number().int().min(0).max(14).optional(),
    leadDays: z.number().int().min(0).max(60).nullable().optional(),
    minOrderValue: money,
    deliveryCharge: money,
    freeDeliveryOver: money,
    orderEmail: z.string().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
    portalUrl: z.string().url().max(500).nullable().optional().or(z.literal('').transform(() => null)),
    notes: text(2000),
    isActive: z.boolean().optional(),
  })
  .strict();

const service = new SupplierSiteAccountService();

export async function supplierSiteAccountRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/suppliers/:id/site-accounts', async (request) => {
    const { id } = params.parse(request.params);
    return { success: true, data: await service.listForSupplier(id) };
  });

  app.put(
    '/suppliers/:id/site-accounts/:siteId',
    { preHandler: requireRole(['admin']) },
    async (request, reply) => {
      const { id, siteId } = siteParams.parse(request.params);
      const parsed = siteAccountBody.safeParse(request.body);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return reply.status(400).send({
          success: false,
          error: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid body',
        });
      }
      try {
        return { success: true, data: await service.upsert(id, siteId, parsed.data) };
      } catch (err) {
        if (err instanceof SupplierNotFoundError || err instanceof SiteNotFoundError) {
          return reply.status(404).send({ success: false, error: err.message });
        }
        throw err;
      }
    },
  );
}
