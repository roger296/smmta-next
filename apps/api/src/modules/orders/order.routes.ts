import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import {
  ShippingLabelConflictError,
  ShippingLabelNotFoundError,
  ShippingLabelService,
} from '../shipping/shipping-label.service.js';
import { PickNoteNotFoundError, PickNoteService } from '../shipping/pick-note.service.js';
import { ShipOrderError, ShipOrderNotFoundError, ShipOrderService } from '../shipping/ship-order.service.js';
import { InvoiceDocumentService } from './invoice-document.service.js';
import { OrderService, OrderValidationError } from './order.service.js';
import { InvoiceService, InvoiceError } from './invoice.service.js';
import {
  createOrderSchema, updateOrderSchema, orderQuerySchema,
  orderStatusChangeSchema, orderNoteSchema, allocateStockSchema,
  createInvoiceFromOrderSchema, createCreditNoteSchema, allocatePaymentSchema,
} from './order.schema.js';
import { paginationSchema } from '../../shared/utils/pagination.js';

const orderService = new OrderService();
const invoiceService = new InvoiceService();

const shippingLabelService = new ShippingLabelService();
const pickNoteService = new PickNoteService();
const shipOrderService = new ShipOrderService();
const invoiceDocumentService = new InvoiceDocumentService();

export async function orderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ═══════════════════════════════════════════════════════════════
  // ORDERS CRUD
  // ═══════════════════════════════════════════════════════════════

  app.get('/orders', async (request) => {
    const user = getAuthUser(request);
    const query = orderQuerySchema.parse(request.query);
    return { success: true, ...await orderService.list(user.companyId, query) };
  });

  app.get('/orders/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await orderService.getById(id, user.companyId);
    if (!data) return reply.status(404).send({ success: false, error: 'Order not found' });
    return { success: true, data };
  });

  app.post('/orders', async (request, reply) => {
    const user = getAuthUser(request);
    const input = createOrderSchema.parse(request.body);
    const data = await orderService.create(user.companyId, input);
    return reply.status(201).send({ success: true, data });
  });

  app.put('/orders/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const input = updateOrderSchema.parse(request.body);
    const data = await orderService.update(id, user.companyId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Order not found' });
    return { success: true, data };
  });

  app.delete('/orders/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const ok = await orderService.delete(id, user.companyId);
    if (!ok) return reply.status(404).send({ success: false, error: 'Order not found' });
    return { success: true, message: 'Order deleted' };
  });

  // ═══════════════════════════════════════════════════════════════
  // ORDER STATUS
  // ═══════════════════════════════════════════════════════════════

  app.put('/orders/:id/status', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const { status } = orderStatusChangeSchema.parse(request.body);
    const data = await orderService.changeStatus(id, user.companyId, status);
    if (!data) return reply.status(404).send({ success: false, error: 'Order not found' });
    return { success: true, data };
  });

  // ═══════════════════════════════════════════════════════════════
  // STOCK ALLOCATION (FIFO)
  // ═══════════════════════════════════════════════════════════════

  app.post('/orders/:id/allocate', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const { warehouseId } = allocateStockSchema.parse(request.body);
      const data = await orderService.allocateStock(id, user.companyId, warehouseId);
      return { success: true, data };
    } catch (err) {
      if (err instanceof OrderValidationError) return reply.status(400).send({ success: false, error: err.message });
      throw err;
    }
  });

  app.post('/orders/:id/deallocate', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await orderService.deallocateStock(id, user.companyId);
    return { success: true, data };
  });

  // ═══════════════════════════════════════════════════════════════
  // ORDER NOTES
  // ═══════════════════════════════════════════════════════════════

  app.post('/orders/:id/notes', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const input = orderNoteSchema.parse(request.body);
    return reply.status(201).send({ success: true, data: await orderService.addNote(id, user.userId, input) });
  });

  app.put('/orders/:id/notes/:noteId', async (request, reply) => {
    const { noteId } = request.params as { noteId: string };
    const input = orderNoteSchema.partial().parse(request.body);
    const data = await orderService.updateNote(noteId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Note not found' });
    return { success: true, data };
  });

  // ═══════════════════════════════════════════════════════════════
  // INVOICE FROM ORDER (triggers GL: CUSTOMER_INVOICE + COGS)
  // ═══════════════════════════════════════════════════════════════

  // ✅ GL TRIGGER: CUSTOMER_INVOICE + MANUAL_JOURNAL (COGS)
  app.post('/orders/:id/invoice', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const input = createInvoiceFromOrderSchema.parse(request.body);
      const data = await invoiceService.createFromOrder(id, user.companyId, user.userId, input);
      return reply.status(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof InvoiceError) return reply.status(400).send({ success: false, error: err.message });
      throw err;
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // INVOICES LIST / DETAIL
  // ═══════════════════════════════════════════════════════════════

  // -- Shipping labels ------------------------------------------------
  // Behind requireAuth like every route here. The PDF route is the only way a
  // label leaves the server: labels hold customer addresses and are stored
  // outside the public /uploads directory for exactly that reason.
  app.get('/orders/:id/shipping-label', async (request) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    return { success: true, data: await shippingLabelService.latestForOrder(id, user.companyId) };
  });

  app.post('/orders/:id/shipping-label', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    // { newShipment: true } replaces a shipment whose label cannot be produced;
    // without it, an existing shipment's label is simply requested again.
    const { newShipment } = z.object({ newShipment: z.boolean().optional() }).parse(request.body ?? {});
    try {
      const label = await shippingLabelService.requestLabel(id, user.companyId, { newShipment });
      return { success: true, data: label };
    } catch (err) {
      if (err instanceof ShippingLabelNotFoundError) {
        return reply.status(404).send({ success: false, error: err.message });
      }
      if (err instanceof ShippingLabelConflictError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      const message = err instanceof Error ? err.message : 'Label request failed';
      return reply.status(502).send({ success: false, error: message });
    }
  });

  app.get('/orders/:id/shipping-label/pdf', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const file = await shippingLabelService.readLabelFile(id, user.companyId);
    if (!file) return reply.status(404).send({ success: false, error: 'No label file for this order' });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'inline; filename="' + file.filename + '"')
      .header('Cache-Control', 'private, no-store')
      .send(file.buffer);
  });

  // -- Pick notes -----------------------------------------------------
  // Same privacy as labels: a pick note carries the customer's name and
  // postcode, so the PDF leaves the server only through this authenticated route.
  app.get('/orders/:id/pick-note', async (request) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    return { success: true, data: await pickNoteService.getForOrder(id, user.companyId) };
  });

  // Re-creates the note even when nothing has changed — for a lost or damaged print.
  app.post('/orders/:id/pick-note', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      return { success: true, data: await pickNoteService.generate(id, user.companyId, { force: true }) };
    } catch (err) {
      if (err instanceof PickNoteNotFoundError) return reply.status(404).send({ success: false, error: err.message });
      const message = err instanceof Error ? err.message : 'Pick note failed';
      return reply.status(500).send({ success: false, error: message });
    }
  });

  // Serves the note, re-creating it first if the order has changed since it was made.
  app.get('/orders/:id/pick-note/pdf', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const file = await pickNoteService.readFile(id, user.companyId);
      if (!file) return reply.status(404).send({ success: false, error: 'No pick note for this order' });
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'inline; filename="' + file.filename + '"')
        .header('Cache-Control', 'private, no-store')
        .send(file.buffer);
    } catch (err) {
      if (err instanceof PickNoteNotFoundError) return reply.status(404).send({ success: false, error: err.message });
      throw err;
    }
  });

  // -- Shipping -------------------------------------------------------
  // What stands between this order and the Ship button, in words.
  app.get('/orders/:id/ship-readiness', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      return { success: true, data: await shipOrderService.readiness(id, user.companyId) };
    } catch (err) {
      if (err instanceof ShipOrderNotFoundError) return reply.status(404).send({ success: false, error: err.message });
      throw err;
    }
  });

  app.post('/orders/:id/ship', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      return { success: true, data: await shipOrderService.ship(id, user.companyId) };
    } catch (err) {
      if (err instanceof ShipOrderNotFoundError) return reply.status(404).send({ success: false, error: err.message });
      if (err instanceof ShipOrderError) {
        return reply
          .status(409)
          .send({ success: false, error: [err.message, ...err.reasons].join(' '), details: { reasons: err.reasons } });
      }
      if (err instanceof InvoiceError) return reply.status(422).send({ success: false, error: err.message });
      throw err;
    }
  });

  // The pick note and label as one PDF, for printing together.
  app.get('/orders/:id/dispatch-documents/pdf', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const file = await shipOrderService.dispatchDocuments(id, user.companyId);
      if (!file) return reply.status(404).send({ success: false, error: 'This order needs both a pick note and a shipping label' });
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'inline; filename="' + file.filename + '"')
        .header('Cache-Control', 'private, no-store')
        .send(file.buffer);
    } catch (err) {
      if (err instanceof ShipOrderNotFoundError) return reply.status(404).send({ success: false, error: err.message });
      throw err;
    }
  });

  app.get('/invoices', async (request) => {
    const user = getAuthUser(request);
    const query = paginationSchema.extend({
      customerId: z.string().uuid().optional(),
      status: z.string().optional(),
      orderId: z.string().uuid().optional(),
    }).parse(request.query);
    return { success: true, ...await invoiceService.list(user.companyId, query) };
  });

  app.get('/invoices/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await invoiceService.getById(id, user.companyId);
    if (!data) return reply.status(404).send({ success: false, error: 'Invoice not found' });
    return { success: true, data };
  });

  // The invoice PDF, made and stored the first time it is asked for.
  app.get('/invoices/:id/pdf', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const file = await invoiceDocumentService.readPdf(id, user.companyId);
    if (!file) return reply.status(404).send({ success: false, error: 'Invoice not found' });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'inline; filename="' + file.filename + '"')
      .header('Cache-Control', 'private, no-store')
      .send(file.buffer);
  });

  // ═══════════════════════════════════════════════════════════════
  // CREDIT NOTES (triggers GL: CUSTOMER_CREDIT_NOTE + COGS reversal)
  // ═══════════════════════════════════════════════════════════════

  // ✅ GL TRIGGER: CUSTOMER_CREDIT_NOTE + MANUAL_JOURNAL (COGS reversal)
  app.post('/invoices/:id/credit-note', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const input = createCreditNoteSchema.parse(request.body);
      const data = await invoiceService.createCreditNote(id, user.companyId, user.userId, input);
      return reply.status(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof InvoiceError) return reply.status(400).send({ success: false, error: err.message });
      throw err;
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // CUSTOMER PAYMENT (triggers GL: CUSTOMER_PAYMENT)
  // ═══════════════════════════════════════════════════════════════

  // ✅ GL TRIGGER: CUSTOMER_PAYMENT
  app.post('/invoices/:id/payment', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const input = allocatePaymentSchema.parse(request.body);
      const data = await invoiceService.allocatePayment(id, user.companyId, user.userId, input);
      return reply.status(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof InvoiceError) return reply.status(400).send({ success: false, error: err.message });
      throw err;
    }
  });
}
