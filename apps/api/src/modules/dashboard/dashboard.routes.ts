/**
 * Dashboard overview — one call for the whole landing page.
 *
 * Mounted at `/api/v1/dashboard` (see `app.ts`). JWT-gated like the rest of the
 * operator surface.
 */
import type { FastifyInstance } from 'fastify';
import { getAuthUser, requireAuth } from '../../shared/middleware/auth.js';
import { DashboardService } from './dashboard.service.js';

const service = new DashboardService();

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // GET /dashboard/overview?date=YYYY-MM-DD  (defaults to yesterday)
  app.get('/dashboard/overview', async (request) => {
    const user = getAuthUser(request);
    const { date } = request.query as { date?: string };
    const data = await service.overview(user.companyId, date);
    return { success: true, data };
  });
}
