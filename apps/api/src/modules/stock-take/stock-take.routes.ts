/**
 * Stock-takes API (P9, spec §A6).
 *
 *   POST /api/v1/stock-takes              — open a take (snapshots book stock)
 *   GET  /api/v1/stock-takes              — list, each take with its progress
 *   GET  /api/v1/stock-takes/:id          — take + lines
 *   POST /api/v1/stock-takes/:id/counts   — record counts (offline-tolerant)
 *   POST /api/v1/stock-takes/:id/approve  — true-up + post adjustment
 *
 * JWT-gated. The iPad stock-take screen (P13) drives these.
 *
 * Role split (Aug-2026 feedback, E-4; locked decision 5): a `head_baker` may
 * open a take and record counts; **approving** one writes the variance
 * straight into the ledger, so that is `site_manager`+.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAuthUser, requireAuth } from '../../shared/middleware/auth.js';
import { actorOf } from '../../shared/auth/actor.js';
import { requireBoundSite, requireRole } from '../../shared/middleware/require-role.js';
import { eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { sites } from '../../db/schema/index.js';
import {
  CountInProgressError,
  StockTakeClosedError,
  StockTakeNotCancellableError,
  StockTakeService,
} from './stock-take.service.js';
import { stockTakeCsv, stockTakeCsvFilename, stockTakesRangeCsv } from './stock-take-export.js';

const openSchema = z.object({
  siteId: z.string().uuid(),
  scope: z.enum(['FULL', 'CATEGORY', 'ZONE', 'ITEM', 'CYCLE']).default('FULL'),
  scopeRef: z.string().max(200).nullable().optional(),
});

const countsSchema = z.object({
  counts: z
    .array(
      z.object({
        productId: z.string().uuid(),
        countedQty: z.coerce.number().min(0),
        countIdempotencyKey: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

const idParamSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  status: z.enum(['OPEN', 'APPROVED', 'CANCELLED']).optional(),
  /** Newest first; the start screen's "Recent counts" asks for a handful. */
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** London calendar days, inclusive (YYYY-MM-DD): opened or approved inside. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const service = new StockTakeService();

export async function stockTakeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post(
    '/stock-takes',
    {
      preHandler: [
        requireRole(['head_baker', 'site_manager']),
        requireBoundSite((request) => (request.body as { siteId?: string } | undefined)?.siteId),
      ],
    },
    async (request, reply) => {
      const parsed = openSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
      }
      try {
        const data = await service.open({
          ...parsed.data,
          openedBy: await actorOf(getAuthUser(request)),
        });
        return reply.status(201).send({ success: true, data });
      } catch (err) {
        // The running count travels with the refusal (in `details`, which the
        // web client passes through) so the screen can join it in one step.
        if (err instanceof CountInProgressError) {
          return reply.status(409).send({
            success: false,
            code: 'COUNT_IN_PROGRESS',
            error: err.message,
            details: { openTakes: err.openTakes },
          });
        }
        throw err;
      }
    },
  );

  app.get('/stock-takes', async (request) => {
    const q = listQuerySchema.parse(request.query);
    const data = await service.list(q);
    return { success: true, data };
  });

  // ── GET /stock-takes/export.csv ───────────────────────────────
  // Every counted line of every take matching the results page's filters
  // (venue, status, date range), one spreadsheet. Static path, so Fastify
  // matches it ahead of /stock-takes/:id.
  app.get('/stock-takes/export.csv', async (request, reply) => {
    const q = listQuerySchema.parse(request.query);
    const takes = await service.list(q);
    const siteRows = await getDb().select({ id: sites.id, name: sites.name }).from(sites);
    const siteName = new Map(siteRows.map((s) => [s.id, s.name]));
    const withLines = [];
    for (const take of takes) {
      withLines.push({ take, siteName: siteName.get(take.siteId) ?? '', lines: await service.linesWithProduct(take.id) });
    }
    const venue = q.siteId ? (siteName.get(q.siteId) ?? 'venue') : 'all-venues';
    const slug = venue.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const span = q.from || q.to ? `${q.from ?? 'start'}-to-${q.to ?? 'today'}` : 'all';
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="stock-takes-${slug}-${span}.csv"`)
      .header('Cache-Control', 'no-store')
      .send(`\uFEFF${stockTakesRangeCsv(withLines)}`);
  });

  // ── POST /stock-takes/:id/cancel ──────────────────────────────
  // Set an open count aside unapplied (managers). Clears the empty sheets
  // left by people starting a count instead of joining one.
  app.post(
    '/stock-takes/:id/cancel',
    { preHandler: [requireRole(['site_manager'])] },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      try {
        const take = await service.cancel(id);
        if (!take) return reply.status(404).send({ success: false, error: 'Stock-take not found' });
        return { success: true, data: take };
      } catch (err) {
        if (err instanceof StockTakeNotCancellableError) {
          return reply.status(409).send({ success: false, error: err.message });
        }
        throw err;
      }
    },
  );

  // ── GET /stock-takes/:id/export.csv ───────────────────────────
  // One count as a spreadsheet, open or approved (see stock-take-export.ts).
  // A plain read — no top-up — so a download never changes the take.
  app.get('/stock-takes/:id/export.csv', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const data = await service.get(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Stock-take not found' });
    const site = await getDb().query.sites.findFirst({ where: eq(sites.id, data.take.siteId) });
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${stockTakeCsvFilename(data.take, site?.name ?? null)}"`)
      .header('Cache-Control', 'no-store')
      // BOM so Excel on Windows opens it as UTF-8 (same as the products export).
      .send(`\uFEFF${stockTakeCsv(data.lines)}`);
  });

  app.get('/stock-takes/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    // topUp: the count screen is how an open take reaches a counter, so this
    // is where a product added since it opened joins the sheet.
    const data = await service.get(id, undefined, { topUp: true });
    if (!data) return reply.status(404).send({ success: false, error: 'Stock-take not found' });
    // Warnings travel with the take so the count screen can show them BEFORE
    // someone approves a write-off (defect D-2).
    return { success: true, data: { ...data, warnings: await service.varianceWarnings(id) } };
  });

  app.post(
    '/stock-takes/:id/counts',
    { preHandler: requireRole(['head_baker', 'site_manager']) },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const parsed = countsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
      }
      try {
        const recorded = await service.recordCounts(
          id,
          parsed.data.counts,
          await actorOf(getAuthUser(request)),
        );
        return { success: true, data: { recorded } };
      } catch (err) {
        if (err instanceof StockTakeClosedError) {
          return reply.status(409).send({ success: false, error: err.message, status: err.status });
        }
        throw err;
      }
    },
  );

  app.post(
    '/stock-takes/:id/approve',
    { preHandler: requireRole(['site_manager']) },
    async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      // Read the warnings BEFORE approving — approval trues the ledger up,
      // after which the variance is zero and the warning has nothing left to
      // point at.
      const warnings = await service.varianceWarnings(id);
      const data = await service.approve(id);
      if (!data) return reply.status(404).send({ success: false, error: 'Stock-take not found' });
      return { success: true, data, warnings };
    },
  );
}
