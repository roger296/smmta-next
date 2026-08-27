/**
 * GET /admin/outbox — operator view of the storefront's email outbox.
 *
 * The outbox lives in the storefront's own database, which the API cannot
 * read, so this proxies the storefront's /api/internal/outbox/status using the
 * shared secret the two services already use. That keeps the secret server-side
 * — the admin SPA authenticates with its normal JWT and never sees it.
 *
 * Read-only: it reports, it does not send or requeue.
 */
import type { FastifyInstance } from 'fastify';
import { getEnv } from '../../config/env.js';
import { requireAuth } from '../../shared/middleware/auth.js';

export async function outboxRoutes(app: FastifyInstance) {
  app.get('/admin/outbox', { preHandler: requireAuth }, async (_request, reply) => {
    const env = getEnv();
    if (!env.STORE_BASE_URL || !env.STORE_INTERNAL_API_KEY) {
      // Surface the misconfiguration rather than an empty page: this is
      // exactly the class of silent gap the outbox view exists to expose.
      return reply.status(503).send({
        success: false,
        error:
          'STORE_BASE_URL / STORE_INTERNAL_API_KEY are not configured, so the storefront outbox cannot be read.',
      });
    }

    const url = `${env.STORE_BASE_URL.replace(/\/$/, '')}/api/internal/outbox/status`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${env.STORE_INTERNAL_API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return reply.status(502).send({
          success: false,
          error: `Storefront returned ${res.status}: ${body.slice(0, 300)}`,
        });
      }
      return { success: true, data: await res.json() };
    } catch (err) {
      return reply.status(502).send({
        success: false,
        error: `Could not reach the storefront: ${err instanceof Error ? err.message : 'unknown'}`,
      });
    }
  });
}
