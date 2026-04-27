/**
 * Operator-facing CRUD for product groups (the storefront's "range"
 * concept). Mounted at `/api/v1/product-groups`. JWT-gated, same as the
 * other admin routes.
 *
 * The storefront read endpoints (Prompt 4) are the public consumers of
 * `productGroups`; this surface is for the admin SPA only.
 */
import type { FastifyInstance } from 'fastify';
import { getAuthUser, requireAuth } from '../../shared/middleware/auth.js';
import { ProductGroupService } from './product.service.js';
import {
  createProductGroupSchema,
  updateProductGroupSchema,
} from './product.schema.js';

const service = new ProductGroupService();

export async function productGroupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/product-groups', async (request) => {
    const user = getAuthUser(request);
    const data = await service.list(user.companyId);
    return { success: true, data };
  });

  app.get('/product-groups/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const group = await service.getById(id, user.companyId);
    if (!group) {
      return reply.status(404).send({ success: false, error: 'Product group not found' });
    }
    return { success: true, data: group };
  });

  app.post('/product-groups', async (request, reply) => {
    const user = getAuthUser(request);
    const parsed = createProductGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    try {
      const group = await service.create(user.companyId, parsed.data);
      return reply.status(201).send({ success: true, data: group });
    } catch (err) {
      // Composite unique on (company_id, slug) bubbles up as a Postgres error.
      if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
        return reply
          .status(409)
          .send({ success: false, error: 'A group with that slug already exists' });
      }
      throw err;
    }
  });

  app.put('/product-groups/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const parsed = updateProductGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    try {
      const updated = await service.update(id, user.companyId, parsed.data);
      if (!updated) {
        return reply.status(404).send({ success: false, error: 'Product group not found' });
      }
      return { success: true, data: updated };
    } catch (err) {
      if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
        return reply
          .status(409)
          .send({ success: false, error: 'A group with that slug already exists' });
      }
      throw err;
    }
  });

  app.delete('/product-groups/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const ok = await service.delete(id, user.companyId);
    if (!ok) {
      return reply.status(404).send({ success: false, error: 'Product group not found' });
    }
    return { success: true, message: 'Product group deleted' };
  });
}
