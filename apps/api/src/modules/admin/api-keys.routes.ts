/**
 * Operator-facing routes for managing service API keys.
 * All endpoints are gated by the existing JWT auth — the storefront
 * itself never calls these.
 *
 * Mounted at `/api/v1/admin/api-keys` (see `app.ts`).
 */
import type { FastifyInstance } from 'fastify';
import { getAuthUser, requireAuth } from '../../shared/middleware/auth.js';
import { ApiKeyService, ApiKeyValidationError } from './api-keys.service.js';
import { createApiKeySchema } from './api-keys.schema.js';

const service = new ApiKeyService();

export async function apiKeyAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // POST /admin/api-keys — issue a new key.
  // Returns the raw key in `data.key` exactly once. Subsequent reads
  // never include it, and the hash is never exposed at all.
  app.post('/admin/api-keys', async (request, reply) => {
    const user = getAuthUser(request);
    try {
      const input = createApiKeySchema.parse(request.body);
      const { row, rawKey } = await service.issue(user.companyId, input);
      return reply.status(201).send({
        success: true,
        data: { ...row, key: rawKey },
      });
    } catch (err) {
      if (err instanceof ApiKeyValidationError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      throw err;
    }
  });

  // GET /admin/api-keys — list live keys for the company.
  app.get('/admin/api-keys', async (request) => {
    const user = getAuthUser(request);
    const rows = await service.list(user.companyId);
    return { success: true, data: rows };
  });

  // POST /admin/api-keys/:id/revoke — revoke a key.
  app.post('/admin/api-keys/:id/revoke', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const row = await service.revoke(id, user.companyId);
    if (!row) {
      return reply.status(404).send({ success: false, error: 'API key not found' });
    }
    return { success: true, data: row };
  });
}
