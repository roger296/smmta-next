/**
 * Inbound-shipment admin routes (SPEC F1, Prompt 4). JWT-gated operator surface:
 * shipment list/detail, create, ETA edit, status, multi-format tracking-refs
 * editor, and goods-in entry. The admin SPA screens (apps/web) consume these.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { InboundService, PresaleOversellError } from './inbound.service.js';

const inbound = new InboundService();

const trackingRefSchema = z.object({
  kind: z.string().min(1),
  value: z.string().min(1),
  carrier: z.string().optional(),
  url: z.string().url().optional(),
});

const createSchema = z.object({
  reference: z.string().min(1),
  mode: z.enum(['sea', 'air', 'road', 'rail', 'courier']).optional(),
  supplier: z.string().optional(),
  carrier: z.string().optional(),
  eta: z.coerce.date(),
  bufferPct: z.number().int().min(0).max(100).optional(),
  trackingRefs: z.array(trackingRefSchema).optional(),
  trackingUrl: z.string().url().optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({ sku: z.string().min(1), qtyManifested: z.number().int().positive() })),
});

export async function inboundRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/inbound/shipments', async () => {
    const data = await inbound.listShipments();
    return { success: true, data };
  });

  app.get('/inbound/shipments/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const data = await inbound.getShipment(id);
    if (!data) return reply.status(404).send({ success: false, error: 'shipment not found' });
    return { success: true, data };
  });

  app.post('/inbound/shipments', async (request, reply) => {
    const input = createSchema.parse(request.body);
    const shipment = await inbound.createShipment(input);
    return reply.status(201).send({ success: true, data: shipment });
  });

  app.patch('/inbound/shipments/:id/eta', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { eta } = z.object({ eta: z.coerce.date() }).parse(request.body);
    const data = await inbound.updateEta(id, eta);
    return reply.send({ success: true, data });
  });

  app.patch('/inbound/shipments/:id/status', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { status } = z
      .object({
        status: z.enum(['booked', 'in_transit', 'at_port', 'customs', 'received', 'reconciled']),
      })
      .parse(request.body);
    const data = await inbound.setStatus(id, status);
    return reply.send({ success: true, data });
  });

  app.put('/inbound/shipments/:id/tracking-refs', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { trackingRefs } = z.object({ trackingRefs: z.array(trackingRefSchema) }).parse(request.body);
    const data = await inbound.setTrackingRefs(id, trackingRefs);
    return reply.send({ success: true, data });
  });

  app.post('/inbound/shipments/:id/goods-in', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { receipts } = z
      .object({
        receipts: z.array(
          z.object({ sku: z.string().min(1), qtyReceived: z.number().int().min(0) }),
        ),
      })
      .parse(request.body);
    await inbound.goodsIn(id, receipts);
    const data = await inbound.getShipment(id);
    return reply.send({ success: true, data });
  });

  // Presale allocate/release (used by checkout; exposed for admin/testing too).
  app.post('/inbound/shipments/:id/allocate', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { sku, qty } = z.object({ sku: z.string(), qty: z.number().int().positive() }).parse(request.body);
    try {
      await inbound.allocatePresale(id, sku, qty);
      return reply.send({ success: true });
    } catch (err) {
      if (err instanceof PresaleOversellError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      throw err;
    }
  });
}
