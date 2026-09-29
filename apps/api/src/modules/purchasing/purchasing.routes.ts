import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { GRNService } from './grn.service.js';
import { SupplierInvoiceService, SupplierInvoiceError } from './supplier-invoice.service.js';
import {
  createPurchaseOrderSchema, updatePurchaseOrderSchema, poQuerySchema,
  createSupplierInvoiceSchema, createSupplierCreditNoteSchema,
} from './purchase-order.schema.js';
import { paginationSchema } from '../../shared/utils/pagination.js';

const poService = new PurchaseOrderService();
const grnService = new GRNService();
const siService = new SupplierInvoiceService();

export async function purchasingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ═══════════════════════════════════════════════════════════════
  // PURCHASE ORDERS
  // ═══════════════════════════════════════════════════════════════

  app.get('/purchase-orders', async (request) => {
    const user = getAuthUser(request);
    const query = poQuerySchema.parse(request.query);
    const result = await poService.list(user.companyId, query);
    return { success: true, ...result };
  });

  app.get('/purchase-orders/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await poService.getById(id, user.companyId);
    if (!data) return reply.status(404).send({ success: false, error: 'Purchase order not found' });
    return { success: true, data };
  });

  app.post('/purchase-orders', async (request, reply) => {
    const user = getAuthUser(request);
    const input = createPurchaseOrderSchema.parse(request.body);
    const data = await poService.create(user.companyId, input);
    return reply.status(201).send({ success: true, data });
  });

  app.put('/purchase-orders/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const input = updatePurchaseOrderSchema.parse(request.body);
    const data = await poService.update(id, user.companyId, input);
    if (!data) return reply.status(404).send({ success: false, error: 'Purchase order not found' });
    return { success: true, data };
  });

  app.post('/purchase-orders/:id/close', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await poService.close(id, user.companyId);
    if (!data) return reply.status(404).send({ success: false, error: 'Purchase order not found' });
    return { success: true, data };
  });

  app.delete('/purchase-orders/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const deleted = await poService.delete(id, user.companyId);
    if (!deleted) return reply.status(404).send({ success: false, error: 'Purchase order not found' });
    return { success: true, message: 'Purchase order deleted' };
  });

  // ═══════════════════════════════════════════════════════════════
  // GRN BOOK-IN (triggers GL: MANUAL_JOURNAL for Stock/GRNI)
  // ═══════════════════════════════════════════════════════════════

  app.get('/purchase-orders/:id/grns', async (request) => {
    const { id } = request.params as { id: string };
    const data = await grnService.listByPO(id);
    return { success: true, data };
  });

  app.get('/grns/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await grnService.getById(id, user.companyId);
    if (!data) return reply.status(404).send({ success: false, error: 'GRN not found' });
    return { success: true, data };
  });

  // Retired (Sept 2026, DECISIONS.md §F24). This booked into the inherited
  // warehouse `stock_items` model, which nothing in Auto-Stock reads, needed a
  // warehouse the venues do not have, matched order lines by product alone,
  // and let a line be over-booked without anyone being asked. Deliveries
  // against an order now go through goods-in, into the venue's stock ledger.
  app.post('/purchase-orders/:id/book-in', async (_request, reply) =>
    reply.status(410).send({
      success: false,
      error:
        'Booking in against a purchase order now goes through goods-in: POST /api/v1/goods-in with ' +
        'purchaseOrderId and a purchaseOrderLineId on each line (see GET /api/v1/purchase-orders/:id/receiving).',
    }),
  );

  // ═══════════════════════════════════════════════════════════════
  // SUPPLIER INVOICES (triggers GL: SUPPLIER_INVOICE)
  // ═══════════════════════════════════════════════════════════════

  app.get('/supplier-invoices', async (request) => {
    const user = getAuthUser(request);
    const query = paginationSchema.extend({
      supplierId: z.string().uuid().optional(),
      purchaseOrderId: z.string().uuid().optional(),
      status: z.string().optional(),
    }).parse(request.query);
    const result = await siService.list(user.companyId, query);
    return { success: true, ...result };
  });

  app.get('/supplier-invoices/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const data = await siService.getById(id, user.companyId);
    if (!data) return reply.status(404).send({ success: false, error: 'Supplier invoice not found' });
    return { success: true, data };
  });

  // ✅ GL TRIGGER: SUPPLIER_INVOICE (Credit AP 2000, Debit GRNI 2310 or expense)
  app.post('/purchase-orders/:id/invoice', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const input = createSupplierInvoiceSchema.parse(request.body);
      const data = await siService.createFromPO(id, user.companyId, user.userId, input);
      return reply.status(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof SupplierInvoiceError) {
        return reply.status(400).send({ success: false, error: err.message });
      }
      throw err;
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // SUPPLIER CREDIT NOTES (triggers GL: SUPPLIER_CREDIT_NOTE)
  // ═══════════════════════════════════════════════════════════════

  // ✅ GL TRIGGER: SUPPLIER_CREDIT_NOTE
  app.post('/supplier-invoices/:id/credit-note', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const input = createSupplierCreditNoteSchema.parse(request.body);
      const data = await siService.createCreditNote(id, user.companyId, user.userId, input);
      return reply.status(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof SupplierInvoiceError) {
        return reply.status(400).send({ success: false, error: err.message });
      }
      throw err;
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // SUPPLIER PAYMENTS (triggers GL: SUPPLIER_PAYMENT)
  // ═══════════════════════════════════════════════════════════════

  const paymentSchema = z.object({
    amount: z.coerce.number().min(0.01),
    paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reference: z.string().optional(),
  });

  // ✅ GL TRIGGER: SUPPLIER_PAYMENT
  app.post('/supplier-invoices/:id/payment', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const input = paymentSchema.parse(request.body);
      const data = await siService.allocatePayment(id, user.companyId, user.userId, input);
      return reply.status(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof SupplierInvoiceError) {
        return reply.status(400).send({ success: false, error: err.message });
      }
      throw err;
    }
  });
}
