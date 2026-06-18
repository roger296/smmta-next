/**
 * Head-baker consumption API (P16, spec §A6).
 *
 *   GET  /api/v1/session-consumption                 — list (site / date filter)
 *   GET  /api/v1/session-consumption/awaiting        — sessions with no record yet
 *   GET  /api/v1/session-consumption/by-session/:sid — record for a session (or 404)
 *   GET  /api/v1/session-consumption/:id             — record + lines
 *   POST /api/v1/session-consumption                 — submit / amend (site-scoped)
 *
 * JWT-gated; the PWA consumption form drives these. A site-bound actor (a
 * head-baker PIN) may only see / submit its own site.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, getAuthUser, canAccessSite } from '../../shared/middleware/auth.js';
import { SessionConsumptionService } from './session-consumption.service.js';
import { BumbleBeeSessionClient } from './bumblebee-sessions.js';
import { ConsumptionSweepService } from './consumption-sweep.service.js';
import { MaterialsCostSyncService } from './materials-cost-sync.service.js';
import { getDb } from '../../config/database.js';
import { sites } from '../../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

const experienceSchema = z.enum(['CLASSIC', 'SWEETER', 'ULTIMATE']);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const submitSchema = z.object({
  sessionId: z.string().min(1).max(200),
  siteId: z.string().uuid(),
  sessionDate: dateSchema,
  bakerName: z.string().min(1).max(200),
  bakerRef: z.string().max(200).nullable().optional(),
  coverGroups: z
    .array(z.object({ experience: experienceSchema, covers: z.coerce.number().min(0) }))
    .max(20)
    .optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        actualQty: z.coerce.number().min(0),
        wastageQty: z.coerce.number().min(0).optional(),
        wastageReason: z.string().max(200).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
  notes: z.string().nullable().optional(),
  clientKey: z.string().max(200).nullable().optional(),
});

const listQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  sessionDate: dateSchema.optional(),
});

const awaitingQuerySchema = z.object({
  siteId: z.string().uuid(),
  date: dateSchema,
});

const service = new SessionConsumptionService();
const sessions = new BumbleBeeSessionClient();
const sweep = new ConsumptionSweepService();
const costSync = new MaterialsCostSyncService();

export async function sessionConsumptionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // Daily COGS / wastage Xero sweep for a date (periodic — locked decision 8).
  app.post('/session-consumption/sweep', async (request, reply) => {
    const parsed = z.object({ date: dateSchema }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Invalid request body' });
    }
    const data = await sweep.runDaily(parsed.data);
    return { success: true, data };
  });

  // Re-push a session's materials cost to BumbleBee (guarded, dry-run default).
  app.post('/session-consumption/:id/sync-cost', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const record = await service.get(id);
    if (!record) return reply.status(404).send({ success: false, error: 'Record not found' });
    const data = await costSync.syncSession(record.record.sessionId);
    return { success: true, data };
  });

  app.get('/session-consumption', async (request) => {
    const q = listQuerySchema.parse(request.query);
    const data = await service.list(q);
    return { success: true, data };
  });

  app.get('/session-consumption/awaiting', async (request, reply) => {
    const q = awaitingQuerySchema.parse(request.query);
    const user = getAuthUser(request);
    if (!canAccessSite(user, q.siteId)) {
      return reply.status(403).send({ success: false, error: 'forbidden_site_scope' });
    }
    const companyId = getSingletonCompanyId();
    const site = await getDb().query.sites.findFirst({
      where: and(eq(sites.id, q.siteId), eq(sites.companyId, companyId)),
    });
    if (!site) return reply.status(404).send({ success: false, error: 'Site not found' });
    const day = await sessions.listSessionsForDay({
      siteCanonicalName: site.canonicalName,
      date: q.date,
      companyId,
    });
    const awaiting = await service.filterAwaiting(q.siteId, day, companyId);
    return { success: true, data: awaiting };
  });

  app.get('/session-consumption/by-session/:sid', async (request, reply) => {
    const { sid } = z.object({ sid: z.string().min(1).max(200) }).parse(request.params);
    const data = await service.getBySession(sid);
    if (!data) return reply.status(404).send({ success: false, error: 'No record for session' });
    return { success: true, data };
  });

  app.get('/session-consumption/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const data = await service.get(id);
    if (!data) return reply.status(404).send({ success: false, error: 'Record not found' });
    return { success: true, data };
  });

  app.post('/session-consumption', async (request, reply) => {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ success: false, error: 'Invalid request body', issues: parsed.error.issues });
    }
    const user = getAuthUser(request);
    try {
      const data = await service.submit(parsed.data, { roles: user.roles, siteId: user.siteId });
      return reply.status(201).send({ success: true, data });
    } catch (err) {
      if ((err as Error).message === 'forbidden_site_scope') {
        return reply.status(403).send({ success: false, error: 'forbidden_site_scope' });
      }
      throw err;
    }
  });
}
