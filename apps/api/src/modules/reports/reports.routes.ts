/**
 * Consumption / wastage / food-cost reports (P18, spec §4/§A6).
 *
 *   GET /api/v1/reports/consumption-variance   — expected vs actual vs counted
 *   GET /api/v1/reports/wastage                — wastage hot-spots
 *   GET /api/v1/reports/food-cost              — food cost per site (+ % if revenue)
 *
 * JWT-gated. Worst-first, plain-English for a non-technical reader.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { ConsumptionReportService } from './consumption-report.service.js';
import { BatchService } from '../stock/batch.service.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const periodSchema = z.object({
  from: dateSchema,
  to: dateSchema,
  siteId: z.string().uuid().optional(),
});
const foodCostSchema = periodSchema.extend({
  revenue: z.coerce.number().min(0).optional(),
});

const service = new ConsumptionReportService();
const batches = new BatchService();

const expiryQuerySchema = z.object({
  asOf: dateSchema,
  withinDays: z.coerce.number().int().min(1).max(365).default(7),
  siteId: z.string().uuid().optional(),
});

export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/reports/expiry', async (request) => {
    const q = expiryQuerySchema.parse(request.query);
    return { success: true, data: await batches.expiryReport(q) };
  });

  app.get('/reports/consumption-variance', async (request) => {
    const q = periodSchema.parse(request.query);
    return { success: true, data: await service.consumptionVariance(q) };
  });

  app.get('/reports/wastage', async (request) => {
    const q = periodSchema.parse(request.query);
    return { success: true, data: await service.wastage(q) };
  });

  app.get('/reports/food-cost', async (request) => {
    const q = foodCostSchema.parse(request.query);
    return { success: true, data: await service.foodCost(q) };
  });
}
