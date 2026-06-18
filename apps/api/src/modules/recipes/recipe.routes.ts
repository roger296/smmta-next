/**
 * Recipes / BOM API (P15, spec §A6).
 *
 *   GET  /api/v1/recipes                 — list (filter by experience / site)
 *   GET  /api/v1/recipes/effective       — the recipe effective for (experience, site, date)
 *   GET  /api/v1/recipes/:id             — recipe + lines
 *   POST /api/v1/recipes                 — create a new version with lines
 *   POST /api/v1/recipes/expected        — expected consumption for a session
 *
 * JWT-gated. The admin Recipes page (versioned editor, per-site override,
 * effective dates) drives these.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { RecipeService } from './recipe.service.js';
import { ExpectedConsumptionService } from './expected-consumption.service.js';

const experienceSchema = z.enum(['CLASSIC', 'SWEETER', 'ULTIMATE']);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const createSchema = z.object({
  experience: experienceSchema,
  siteId: z.string().uuid().nullable().optional(),
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable().optional(),
  name: z.string().max(200).nullable().optional(),
  notes: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        qtyPerCover: z.coerce.number().positive(),
        stockUom: z.string().max(20).optional(),
        unitCost: z.coerce.number().min(0).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

const listQuerySchema = z.object({
  experience: experienceSchema.optional(),
  siteId: z.string().uuid().optional(),
});

const effectiveQuerySchema = z.object({
  experience: experienceSchema,
  siteId: z.string().uuid(),
  onDate: dateSchema,
});

const expectedSchema = z.object({
  siteId: z.string().uuid(),
  onDate: dateSchema,
  coverGroups: z
    .array(z.object({ experience: experienceSchema, covers: z.coerce.number().min(0) }))
    .min(1)
    .max(20),
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
