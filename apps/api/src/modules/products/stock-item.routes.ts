import type { FastifyInstance } from 'fastify';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { StockItemService, StockValidationError } from './stock-item.service.js';
import {
  stockItemQuerySchema,
  stockAdjustmentSchema,
  stockTransferSchema,
  stockReportQuerySchema,
} from './stock-item.schema.js';

const stockItemService = new StockItemService();

export async function stockItemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ── GET /stock-items ──────────────────────────────────────────
  app.get('/stock-items', async (request) => {
    const user = getAuthUser(request);
    const query = stockItemQuerySchema.parse(request.query);
    const result = await stockItemService.list(user.companyId, query);
    return { success: true, ...result };
  });

  // ── GET /stock-items/:id ──────────────────────────────────────
  app.get('/stock-items/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const item = await stockItemService.getById(id, user.companyId);
    if (!item) return reply.status(404).send({ success: false, error: 'Stock item not found' });
    return { success: true, data: item };
  });

  // ── POST /stock-items/adjust ──────────────────────────────────
  // Manual stock add or remove — TRIGGERS GL POSTING
  app.post('/stock-items/adjust', async (request, reply) => {
    const user = getAuthUser(request);
    try {
      const input = stockAdjustmentSchema.parse(request.body);
      const result = await stockItemService.adjust(user.companyId, user.userId, input);
      return reply.status(201).send({ success: true, data: result });
    } catch (err) {
      if (err instanceof StockValidationError) {
        return reply.status(400).send({ success: false, error: err.message });
      }
      throw err;
    }
  });

  // ── POST /stock-items/transfer ────────────────────────────────
  // Warehouse-to-warehouse transfer — no GL posting
  app.post('/stock-items/transfer', async (request, reply) => {
    const user = getAuthUser(request);
    try {
      const input = stockTransferSchema.parse(request.body);
      const result = await stockItemService.transfer(user.companyId, input);
      return { success: true, data: result };
    } catch (err) {
      if (err instanceof StockValidationError) {
        return reply.status(400).send({ success: false, error: err.message });
      }
      throw err;
    }
  });

  // ── GET /stock-items/report ───────────────────────────────────
  // Stock valuation report
  app.get('/stock-items/report', async (request) => {
    const user = getAuthUser(request);
    const query = stockReportQuerySchema.parse(request.query);
    const report = await stockItemService.getStockReport(user.companyId, query);
    return { success: true, data: report };
  });

  // ── GET /stock-items/check-serial/:serialNumber ───────────────
  app.get('/stock-items/check-serial/:serialNumber', async (request) => {
    const user = getAuthUser(request);
    const { serialNumber } = request.params as { serialNumber: string };
    const exists = await stockItemService.checkSerialNumber(serialNumber, user.companyId);
    return { success: true, data: { exists } };
  });
}
