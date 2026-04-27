/**
 * Public storefront read endpoints.
 *
 * Mounted at `/api/v1/storefront/*`. Every route is gated by
 * `apiKeyAuth(['storefront:read'])`. Bodies omit operational fields (cost,
 * supplier, marketplace identifiers, etc.) and include only `is_published = true`
 * rows.
 *
 * Responses set `Cache-Control: public, max-age=30, stale-while-revalidate=60`
 * so the storefront RSC layer and any edge cache can re-use payloads.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyAuth, getApiKeyContext } from '../../shared/middleware/api-key.js';
import { CatalogueService } from './catalogue.service.js';

const CACHE_HEADER = 'public, max-age=30, stale-while-revalidate=60';

const productIdsQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(z.string().uuid()).min(1).max(100)),
});

const slugParamSchema = z.object({
  slug: z.string().min(1).max(200),
});

const service = new CatalogueService();

export async function storefrontReadRoutes(app: FastifyInstance) {
  // All routes require an api key with storefront:read scope.
  app.addHook('preHandler', apiKeyAuth(['storefront:read']));

  // GET /storefront/groups — published groups + thin variants
  app.get(
    '/storefront/groups',
    {
      schema: {
        tags: ['storefront'],
        summary: 'List published product groups for the storefront',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const data = await service.listGroups(ctx.companyId);
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data });
    },
  );

  // GET /storefront/groups/:slug — full group + full variants
  app.get(
    '/storefront/groups/:slug',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Get a single published group by slug',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { slug } = slugParamSchema.parse(request.params);
      const group = await service.getGroupBySlug(ctx.companyId, slug);
      if (!group) {
        return reply.status(404).send({ success: false, error: 'Group not found' });
      }
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data: group });
    },
  );

  // GET /storefront/products?ids=<csv> — batch lookup for cart price snapshots
  // (registered before /storefront/products/:slug so Fastify's path matching
  // resolves the static path first).
  app.get(
    '/storefront/products',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Batch-fetch published products by id (cart price snapshots)',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const parsed = productIdsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Missing or invalid ids parameter' });
      }
      const data = await service.getProductsByIds(ctx.companyId, parsed.data.ids);
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data });
    },
  );

  // GET /storefront/products/:slug — single product (works for standalone
  // and grouped products alike).
  app.get(
    '/storefront/products/:slug',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Get a single published product by slug',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { slug } = slugParamSchema.parse(request.params);
      const product = await service.getProductBySlug(ctx.companyId, slug);
      if (!product) {
        return reply.status(404).send({ success: false, error: 'Product not found' });
      }
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data: product });
    },
  );
}
