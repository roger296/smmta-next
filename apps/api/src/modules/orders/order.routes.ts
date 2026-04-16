import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
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
