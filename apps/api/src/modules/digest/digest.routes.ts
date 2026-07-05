/**
 * Admin digest route (SPEC §6). JWT-gated. Returns the same payload the daily
 * agent-digest email assembles, so the operator can see it on demand.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../shared/middleware/auth.js';
import { DigestService } from './digest.service.js';

const digest = new DigestService();

export async function digestRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.get('/admin/digest', async () => ({ success: true, data: await digest.buildDigest() }));
}
