/**
 * Recipes / BOM API (P15, spec §A6).
 *
 *   GET  /api/v1/recipes                 — list (filter by cake / site)
 *   GET  /api/v1/recipes/bakes           — the distinct cakes (the menu)
 *   GET  /api/v1/recipes/effective       — the recipe effective for (cake, site, date)
 *   GET  /api/v1/recipes/:id             — recipe + lines
 *   POST /api/v1/recipes                 — create a new version with lines
 *   POST /api/v1/recipes/expected        — expected consumption for a session
 *
 * JWT-gated. A recipe is keyed by the **cake** (`bake`, free-form), not an
 * experience package tier. The admin Recipes page drives these.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { RecipeService } from './recipe.service.js';
import { ExpectedConsumptionService } from './expected-consumption.service.js';

const bakeSchema = z.string().min(1).max(200);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const createSchema = z.object({
  bake: bakeSchema,
  siteId: z.string().uuid().nullable().optional(),
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  notes: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        variant: z
          .enum(['BASE', 'GF_REMOVE', 'GF_ADD', 'VEGAN_REMOVE', 'VEGAN_ADD'])
          .optional(),
        // Zero is valid for a removal line, where the quantity carries no
        // meaning — the whole ingredient comes out.
        qtyPerCover: z.coerce.number().min(0),
        stockUom: z.string().max(20).optional(),
        unitCost: z.coerce.number().min(0).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

/** An amendment. bake/siteId/version are the version's identity and are not
 *  editable — superseding a recipe means adding a version, not renaming one. */
const updateSchema = createSchema
  .omit({ bake: true, siteId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const listQuerySchema = z.object({
  bake: bakeSchema.optional(),
  siteId: z.string().uuid().optional(),
});

const effectiveQuerySchema = z.object({
  bake: bakeSchema,
  siteId: z.string().uuid(),
  onDate: dateSchema,
});

const expectedSchema = z.object({
  bake: bakeSchema,
  siteId: z.string().uuid(),
  onDate: dateSchema,
  covers: z.coerce.number().min(0),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const recipes = new RecipeService();
const expected = new ExpectedConsumptionService();

export async function recipeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/recipes', async (request) => {
    const q = listQuerySchema.parse(request.query);
    const data = await recipes.list(q);
    return { success: true, data };
  });

  app.get('/recipes/bakes', async () => {
    return { success: true, data: await recipes.listBakes() };
  });

  app.get('/recipes/effective', async (request, reply) => {
    const q = effectiveQuerySchema.parse(request.query);
    const data = await expected.getEffectiveRecipe(q);
    if (!data) return reply.status(404).send({ success: false, error: 'No effective recipe' });
    return { success: true, data };
  });

  app.post('/recipes/expected', async (request, reply) => {
    const parsed = expectedSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await expected.expectedForSession(parsed.data);
    return { success: true, data };
  });

  app.get('/recipes/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const data = await recipes.get(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Recipe not found' });
    return { success: true, data };
  });

  app.put('/recipes/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = updateSchema.parse(request.body);
    const result = await recipes.update(id, body);
    if (!result) return reply.status(404).send({ success: false, error: 'Recipe not found' });
    return { success: true, data: result };
  });

  app.delete('/recipes/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const removed = await recipes.remove(id);
    if (!removed) return reply.status(404).send({ success: false, error: 'Recipe not found' });
    return { success: true, data: { id } };
  });

  app.post('/recipes', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await recipes.create(parsed.data);
    return reply.status(201).send({ success: true, data });
  });
}
