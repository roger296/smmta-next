/**
 * Stock-take-lite API (P26) — the standalone iPad demo.
 *
 *   POST /api/v1/stocktake-lite/sync                 — a device pushes its counts
 *   GET  /api/v1/stocktake-lite/sites?period=        — sites with submissions
 *   GET  /api/v1/stocktake-lite/consolidate?period&site — consolidated + conflicts
 *   POST /api/v1/stocktake-lite/resolve              — settle a conflict
 *   GET  /api/v1/stocktake-lite/export.csv?period&site  — merged CSV
 *
 * NOT JWT-gated (the demo runs on managers' iPads without admin logins).
 * Instead every route checks a shared access code in the `x-stocktake-code`
 * header against STOCKTAKE_ACCESS_CODE. If that env is unset the gate is open —
 * fine for local dev, but a deployment MUST set it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { StockTakeLiteService } from './stocktake-lite.service.js';

const syncSchema = z.object({
  period: z.string().min(1).max(40),
  siteSlug: z.string().min(1).max(80),
  deviceId: z.string().min(1).max(80),
  counterName: z.string().min(1).max(120),
  counts: z
    .array(
      z.object({
        itemKey: z.string().min(1).max(200),
        itemName: z.string().min(1).max(300),
        section: z.string().max(200).nullable().optional(),
        packSize: z.string().max(200).nullable().optional(),
        quantity: z.coerce.number().min(0),
        isCustom: z.boolean().optional(),
      }),
    )
    .max(2000),
});

const periodQuerySchema = z.object({ period: z.string().min(1).max(40) });
const consolidateQuerySchema = z.object({
  period: z.string().min(1).max(40),
  site: z.string().min(1).max(80),
});
const exportQuerySchema = z.object({
  period: z.string().min(1).max(40),
  site: z.string().min(1).max(80).optional(),
});
const resolveSchema = z.object({
  period: z.string().min(1).max(40),
  siteSlug: z.string().min(1).max(80),
  groupKey: z.string().min(1).max(300),
  resolvedQty: z.coerce.number().min(0),
  resolvedBy: z.string().max(120).nullable().optional(),
});

const service = new StockTakeLiteService();

/** Shared-access-code gate. Open when STOCKTAKE_ACCESS_CODE is unset. */
function requireAccessCode(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const expected = process.env.STOCKTAKE_ACCESS_CODE;
  if (!expected) {
    done();
    return;
  }
  const provided = request.headers['x-stocktake-code'];
  if (provided === expected) {
    done();
    return;
  }
  void reply.status(401).send({ success: false, error: 'Invalid or missing access code' });
}

export async function stockTakeLiteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAccessCode);

  app.post('/stocktake-lite/sync', async (request, reply) => {
    const parsed = syncSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const data = await service.sync(parsed.data);
    return { success: true, data };
  });

  app.get('/stocktake-lite/sites', async (request, reply) => {
    const parsed = periodQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'period is required' });
    }
    const data = await service.sites(parsed.data.period);
    return { success: true, data };
  });

  app.get('/stocktake-lite/consolidate', async (request, reply) => {
    const parsed = consolidateQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'period and site are required' });
    }
    const data = await service.consolidate(parsed.data.period, parsed.data.site);
    return { success: true, data };
  });

  app.post('/stocktake-lite/resolve', async (request, reply) => {
    const parsed = resolveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    await service.resolve(parsed.data);
    return { success: true };
  });

  app.get('/stocktake-lite/export.csv', async (request, reply) => {
    const parsed = exportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'period is required' });
    }
    const csv = await service.exportCsv(parsed.data.period, parsed.data.site);
    const name = parsed.data.site
      ? `stocktake-${parsed.data.period}-${parsed.data.site}.csv`
      : `stocktake-${parsed.data.period}-all-sites.csv`;
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(csv);
  });
}
