/**
 * Buying-data health (supplier-ordering groundwork, plan §5.2).
 *
 *   GET /api/v1/buying-data/health   what would stop an option being compared:
 *                                    no buying option, no pack size, no price,
 *                                    a stale price, a price move, venues a
 *                                    supplier cannot be dated for
 *
 * Read-only; head office and venue managers.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../shared/middleware/auth.js';
import { requireRole } from '../../shared/middleware/require-role.js';
import { buyingDataHealth } from './buying-data-health.service.js';

export async function buyingDataRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.get('/buying-data/health', { preHandler: requireRole(['site_manager']) }, async () => ({
    success: true,
    data: await buyingDataHealth(),
  }));
}
