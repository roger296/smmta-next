/**
 * Shared-device PIN login (P12, spec §A11/§A12 q10).
 *
 *   POST /api/v1/auth/pin-login   { pin, siteId? }   → 200 { token, user }
 *   POST /api/v1/device-pins      (admin) create a PIN
 *
 * Shared site iPads: each person taps in a PIN scoped to their site + roles and
 * gets a short-lived (12h) scoped JWT. The PIN is scrypt-hashed (same helper as
 * user passwords). The login is public (it IS the login); creating PINs is
 * JWT-gated.
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { devicePins, sites } from '../../db/schema/index.js';
import { hashPassword, verifyPassword } from '../../shared/auth/password.js';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';

const pinLoginSchema = z.object({
  pin: z.string().min(3).max(64),
  siteId: z.string().uuid().optional(),
});

const createPinSchema = z.object({
  label: z.string().min(1).max(120),
  pin: z.string().min(3).max(64),
  siteId: z.string().uuid().nullable().optional(),
  roles: z.array(z.string()).optional(),
});

export async function pinAuthRoutes(app: FastifyInstance) {
  app.post('/auth/pin-login', async (request, reply) => {
    const parsed = pinLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'invalid_request' });
    }
    const db = getDb();
    const where = [eq(devicePins.isActive, true)];
    if (parsed.data.siteId) where.push(eq(devicePins.siteId, parsed.data.siteId));
    const rows = await db.query.devicePins.findMany({ where: and(...where) });
    for (const row of rows) {
      if (await verifyPassword(parsed.data.pin, row.pinHash)) {
        const token = app.jwt.sign(
          {
            userId: `pin:${row.id}`,
            companyId: row.companyId,
            email: `${row.label}@pin.local`,
            roles: row.roles,
            siteId: row.siteId,
            label: row.label,
          },
          { expiresIn: '12h' },
        );
        // The site NAME travels with the login (Aug-2026 feedback, E-1/B-5).
        // The id alone is not something a venue screen can put in front of a
        // baker, and the client discarding this response is precisely how a
        // South London iPad ended up booking to Birmingham.
        const site = row.siteId
          ? await db.query.sites.findFirst({ where: eq(sites.id, row.siteId) })
          : null;
        return {
          success: true,
          data: {
            token,
            user: {
              label: row.label,
              roles: row.roles,
              siteId: row.siteId,
              siteName: site?.name ?? null,
            },
          },
        };
      }
    }
    return reply.status(401).send({ success: false, error: 'invalid_pin' });
  });

  app.post('/device-pins', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createPinSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'invalid_request' });
    }
    const user = getAuthUser(request);
    const pinHash = await hashPassword(parsed.data.pin);
    const [row] = await getDb()
      .insert(devicePins)
      .values({
        companyId: user.companyId,
        siteId: parsed.data.siteId ?? null,
        label: parsed.data.label,
        pinHash,
        roles: parsed.data.roles ?? ['head_baker'],
      })
      .returning();
    return reply.status(201).send({ success: true, data: { id: row!.id, label: row!.label } });
  });
}
