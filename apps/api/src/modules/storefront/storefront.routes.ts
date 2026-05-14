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
import { CategoryService, type CategoryFilters, type SortKey } from './category.service.js';
import type { StockState } from './availability.js';
import { OrderCommitService } from './order-commit.service.js';
import { SearchService } from './search/search.service.js';
import {
  InsufficientStockError,
  ReservationService,
} from './reservation.service.js';

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
const categoryService = new CategoryService();
const searchService = new SearchService({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  dailyBudgetGbp: (() => {
    const v = Number.parseFloat(process.env.LLM_SEARCH_BUDGET_GBP_PER_DAY ?? '5');
    return Number.isFinite(v) && v >= 0 ? v : 5;
  })(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(240),
});

// Filter parsing for the category endpoint. The storefront sends:
//   ?stock=IN_STOCK,AVAILABLE_FROM_SUPPLIER
//   ?colour=Navy,Black
//   ?size=L,XL
//   ?brand=Russell,Stedman
//   ?price=10-40   (range as "min-max"; either side optional: "-40" / "10-")
//   ?sort=newest|price-asc|price-desc
//   ?page=2
// Use a permissive schema so partial / typo'd inputs degrade
// gracefully — a bad filter returns an empty result, not a 400.
const categoryQuerySchema = z.object({
  stock: z.string().optional(),
  colour: z.string().optional(),
  size: z.string().optional(),
  brand: z.string().optional(),
  price: z.string().optional(),
  sort: z.enum(['newest', 'price-asc', 'price-desc']).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional(),
});

function parseCsv(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function parsePriceBand(v: string | undefined): { priceMin?: number; priceMax?: number } {
  if (!v) return {};
  const m = /^(\d+(?:\.\d+)?)?-(\d+(?:\.\d+)?)?$/.exec(v.trim());
  if (!m) return {};
  const min = m[1] !== undefined ? Number(m[1]) : undefined;
  const max = m[2] !== undefined ? Number(m[2]) : undefined;
  return {
    priceMin: min !== undefined && Number.isFinite(min) ? min : undefined,
    priceMax: max !== undefined && Number.isFinite(max) ? max : undefined,
  };
}

function parseStockStates(v: string | undefined): StockState[] | undefined {
  if (!v) return undefined;
  const wanted = parseCsv(v) ?? [];
  const ok: StockState[] = [];
  for (const s of wanted) {
    if (s === 'IN_STOCK' || s === 'AVAILABLE_FROM_SUPPLIER' || s === 'OUT_OF_STOCK') {
      ok.push(s);
    }
  }
  return ok.length > 0 ? ok : undefined;
}

const categorySlugPathSchema = z.object({
  // URL-encoded slug path: `top` or `top%2Fsub`. Limit prevents
  // adversarial inputs from doing too much work.
  path: z.string().min(1).max(200),
});

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
      const data = await service.listGroups(ctx.companyId, ctx.channelId);
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
      const group = await service.getGroupBySlug(ctx.companyId, slug, ctx.channelId);
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
      const data = await service.getProductsByIds(ctx.companyId, parsed.data.ids, ctx.channelId);
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data });
    },
  );

  // GET /storefront/categories — nav tree (top-tiers + their subcategories).
  // No auth-channel scoping needed; categories themselves are
  // catalogue-wide. Cached.
  app.get(
    '/storefront/categories',
    {
      schema: {
        tags: ['storefront'],
        summary: 'List the published category nav tree (top-tiers + subcategories)',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const data = await categoryService.listNav(ctx.companyId);
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data });
    },
  );

  // GET /storefront/categories/:path/products — products within a
  // category (top-tier or subcategory) with filters + facets + paging.
  //
  // `:path` is a single URL segment containing the slug path with
  // `/` URL-encoded as `%2F`. Two-tier max:
  //   /storefront/categories/tops/products
  //   /storefront/categories/tops%2Fpolo-shirts/products
  app.get(
    '/storefront/categories/:path/products',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Products + facets + paging for a category slug path',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { path } = categorySlugPathSchema.parse(request.params);
      const query = categoryQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ success: false, error: 'Invalid query parameters' });
      }
      const filters: CategoryFilters = {
        stockState: parseStockStates(query.data.stock),
        colour: parseCsv(query.data.colour),
        size: parseCsv(query.data.size),
        brand: parseCsv(query.data.brand),
        ...parsePriceBand(query.data.price),
      };
      const sort: SortKey = query.data.sort ?? 'newest';
      const result = await categoryService.listCategoryProducts(
        ctx.companyId,
        decodeURIComponent(path),
        ctx.channelId,
        { filters, sort, page: query.data.page ?? 1 },
      );
      if (!result) {
        return reply.status(404).send({ success: false, error: 'Category not found' });
      }
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data: result });
    },
  );

  // GET /storefront/search — conversational search.
  //
  // ?q=<encoded query>  →  { interpretation, products, totalCount, ... }
  //
  // Server-side LLM parsing (Claude Haiku) maps the natural-language
  // query to a structured filter set + a category slug; the result
  // is fed into the same `CategoryService.listCategoryProducts` that
  // backs the /shop/c/... pages. If the LLM call fails / the API key
  // isn't configured / the day's budget is blown, we fall through to
  // a keyword search across product names. The customer always gets
  // something — interpretation text plus whatever the system could
  // find.
  //
  // No cache-control header — search results are personalised to the
  // exact query string, so HTTP caching just inflates the URL space
  // without buying us much. Per-query caching happens in
  // SearchService's in-memory Map.
  app.get(
    '/storefront/search',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Conversational search — parse a natural-language query and return matching products',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const parsed = searchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: 'Missing or invalid q parameter' });
      }
      const data = await searchService.search({
        query: parsed.data.q,
        companyId: ctx.companyId,
        channelId: ctx.channelId,
      });
      return reply.send({ success: true, data });
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
      const product = await service.getProductBySlug(ctx.companyId, slug, ctx.channelId);
      if (!product) {
        return reply.status(404).send({ success: false, error: 'Product not found' });
      }
      return reply.header('Cache-Control', CACHE_HEADER).send({ success: true, data: product });
    },
  );
}

// ===========================================================================
// Write surface — gated by `storefront:write`.
// Reservations + order commit + status + cancellation. See Prompt 5 of
// `buldmeawebstore.md`. Storefront read endpoints stay on `storefront:read`.
// ===========================================================================

const reservationItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(99),
});

const createReservationBodySchema = z.object({
  items: z.array(reservationItemSchema).min(1).max(50),
  ttlSeconds: z.number().int().min(60).max(60 * 60).optional(),
});

const addressSchema = z.object({
  line1: z.string().min(1).max(255),
  line2: z.string().max(255).optional(),
  city: z.string().min(1).max(100),
  region: z.string().max(100).optional(),
  postCode: z.string().min(1).max(50),
  country: z.string().min(1).max(50),
  contactName: z.string().max(100).optional(),
});

const commitOrderBodySchema = z.object({
  reservationId: z.string().uuid(),
  customer: z.object({
    email: z.string().email().max(100),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    phone: z.string().max(50).optional(),
  }),
  deliveryAddress: addressSchema,
  invoiceAddress: addressSchema.optional(),
  mollie: z.object({
    paymentId: z.string().min(1).max(100),
    amount: z.string().regex(/^\d+(\.\d{2})?$/, 'amount must be a major-unit string like "24.50"'),
    currency: z.string().length(3),
    methodPaid: z.string().min(1).max(50),
    status: z.string().min(1).max(50),
  }),
  deliveryCharge: z
    .string()
    .regex(/^\d+(\.\d{2})?$/, 'deliveryCharge must be a major-unit string')
    .optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const reservationService = new ReservationService();
const commitService = new OrderCommitService();

export async function storefrontWriteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:write']));

  // POST /storefront/reservations
  app.post(
    '/storefront/reservations',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Reserve stock for a basket prior to payment',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const parsed = createReservationBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
      }
      try {
        const result = await reservationService.createReservation(ctx.companyId, {
          items: parsed.data.items,
          ttlSeconds: parsed.data.ttlSeconds ?? 15 * 60,
        });
        return reply.status(201).send({
          success: true,
          data: {
            reservationId: result.reservationId,
            expiresAt: result.expiresAt.toISOString(),
            lines: result.lines,
          },
        });
      } catch (err) {
        if (err instanceof InsufficientStockError) {
          return reply.status(409).send({
            success: false,
            error: 'INSUFFICIENT_STOCK',
            productId: err.productId,
            available: err.available,
            requested: err.requested,
          });
        }
        throw err;
      }
    },
  );

  // DELETE /storefront/reservations/:id  → 204 (idempotent)
  app.delete(
    '/storefront/reservations/:id',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Release a held reservation early',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { id } = idParamSchema.parse(request.params);
      await reservationService.releaseReservation(id, ctx.companyId);
      return reply.status(204).send();
    },
  );

  // POST /storefront/orders — commit the reservation into a confirmed order.
  app.post(
    '/storefront/orders',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Commit a reservation into a confirmed order (idempotent)',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
        return reply
          .status(400)
          .send({ success: false, error: 'Idempotency-Key header is required (≥ 8 chars)' });
      }
      const parsed = commitOrderBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
      }

      const { status, body } = await commitService.commitOrder(
        ctx.companyId,
        idempotencyKey,
        parsed.data,
      );
      return reply.status(status).send(body);
    },
  );

  // GET /storefront/orders/:id — public-safe order projection.
  app.get(
    '/storefront/orders/:id',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Fetch a customer-safe order projection',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { id } = idParamSchema.parse(request.params);
      const order = await commitService.getPublicOrder(ctx.companyId, id);
      if (!order) {
        return reply.status(404).send({ success: false, error: 'Order not found' });
      }
      return reply.send({ success: true, data: order });
    },
  );

  // POST /storefront/orders/:id/cancel
  app.post(
    '/storefront/orders/:id/cancel',
    {
      schema: {
        tags: ['storefront'],
        summary: 'Cancel an order if it has not yet shipped',
      },
    },
    async (request, reply) => {
      const ctx = getApiKeyContext(request);
      const { id } = idParamSchema.parse(request.params);
      const result = await commitService.cancelOrder(ctx.companyId, id);
      if (!result.ok && result.error === 'NOT_FOUND') {
        return reply.status(404).send({ success: false, error: 'Order not found' });
      }
      if (!result.ok) {
        return reply.status(409).send({
          success: false,
          error: 'NOT_CANCELLABLE',
          currentStatus: result.currentStatus,
        });
      }
      return reply.send({ success: true, data: { status: result.status } });
    },
  );
}
