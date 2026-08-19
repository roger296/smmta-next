/**
 * Sites admin API (spec §A5).
 *
 *   GET   /api/v1/sites          — list all sites
 *   POST  /api/v1/sites          — create a site
 *   GET   /api/v1/sites/:id      — one site
 *   PATCH /api/v1/sites/:id      — update a site
 *
 * Adding a site is a single admin action — currency + UoM system + timezone
 * are first-class fields so a USD/imperial site (Dallas, P20) needs no code
 * change. JWT-gated (operators/managers).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { SiteService, SiteSlugTakenError } from './site.service.js';

const idParamSchema = z.object({ id: z.string().uuid() });

const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case (lowercase, hyphen-separated)');

const createSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(200),
  canonicalName: z.string().min(1).max(200).optional(),
  currencyCode: z.string().length(3).optional(),
  uomSystem: z.enum(['METRIC', 'IMPERIAL']).optional(),
  timezone: z.string().min(1).max(64).optional(),
  isActive: z.boolean().optional(),
  /**
   * Benches per table (Aug-2026, F-7). Positive, or null for "not set" —
   * zero is not a smaller number of benches, it is a missing answer.
   */
  benchesPerTable: z.coerce.number().positive().nullable().optional(),
});

const updateSchema = createSchema.partial();

const service = new SiteService();

export async function siteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/sites', async () => {
    const data = await service.list();
    return { success: true, data };
  });

  app.post('/sites', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    try {
      const data = await service.create(parsed.data);
      return reply.status(201).send({ success: true, data });
    } catch (err) {
      if (err instanceof SiteSlugTakenError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      throw err;
    }
  });

  app.get('/sites/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const data = await service.get(id);
    if (!data) {
      return reply.status(404).send({ success: false, error: 'Site not found' });
    }
    return { success: true, data };
  });

  app.patch('/sites/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    try {
      const data = await service.update(id, parsed.data);
      if (!data) {
        return reply.status(404).send({ success: false, error: 'Site not found' });
      }
      return { success: true, data };
    } catch (err) {
      if (err instanceof SiteSlugTakenError) {
        return reply.status(409).send({ success: false, error: err.message });
      }
      throw err;
    }
  });
}
