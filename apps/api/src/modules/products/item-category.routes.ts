import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { ItemCategoryInUseError, ItemCategoryService } from './item-category.service.js';

const service = new ItemCategoryService();

const nameSchema = z.object({
  name: z.string().trim().min(1, 'A category needs a name').max(100),
  sortOrder: z.number().int().optional(),
});

export async function itemCategoryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ── GET /item-categories ──────────────────────────────────────
  app.get('/item-categories', async (request) => {
    const user = getAuthUser(request);
    return { success: true, data: await service.list(user.companyId) };
  });

  // ── POST /item-categories ─────────────────────────────────────
  // Adding a category from the product form. Idempotent: an existing name
  // returns that category with created=false rather than a 409, because the
  // caller wanted "a category called X" and now has one.
  app.post('/item-categories', async (request, reply) => {
    const user = getAuthUser(request);
    const parsed = nameSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', details: parsed.error.issues });
    }
    const { row, created } = await service.create(
      parsed.data.name,
      user.companyId,
      parsed.data.sortOrder ?? 0,
    );
    return reply.status(created ? 201 : 200).send({ success: true, data: { ...row, created } });
  });

  // ── PATCH /item-categories/:id ────────────────────────────────
  app.patch('/item-categories/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    const parsed = nameSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', details: parsed.error.issues });
    }
    const row = await service.rename(id, parsed.data.name, user.companyId);
    if (!row) return reply.status(404).send({ success: false, error: 'Item category not found' });
    return { success: true, data: row };
  });

  // ── DELETE /item-categories/:id ───────────────────────────────
  app.delete('/item-categories/:id', async (request, reply) => {
    const user = getAuthUser(request);
    const { id } = request.params as { id: string };
    try {
      const removed = await service.remove(id, user.companyId);
      if (!removed) return reply.status(404).send({ success: false, error: 'Item category not found' });
      return { success: true, data: { id } };
    } catch (err) {
      if (err instanceof ItemCategoryInUseError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      throw err;
    }
  });
}
