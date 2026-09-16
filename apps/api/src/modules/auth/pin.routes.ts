/**
 * Shared-device PIN login (P12, spec §A11/§A12 q10).
 *
 *   POST   /api/v1/auth/pin-login        { pin, siteId? }  → 200 { token, user }
 *   GET    /api/v1/device-pins/me        the signed-in PIN's venues
 *   POST   /api/v1/device-pins/me/sites  { siteId }  add a venue (self-service)
 *   DELETE /api/v1/device-pins/me/sites/:siteId      remove one
 *   GET    /api/v1/device-pins           (admin) every PIN + its venues
 *   DELETE /api/v1/device-pins/:id/sites/:siteId     (admin) revoke a venue
 *   POST   /api/v1/device-pins           (admin) create a PIN
 *
 * Shared site iPads: each person taps in a PIN and gets a short-lived (12h)
 * scoped JWT. The PIN is scrypt-hashed (same helper as user passwords). The
 * login is public (it IS the login); everything else is JWT-gated.
 *
 * ── MULTI-VENUE BAKERS (Sept-2026 user testing, item 1) ────────────────────
 * "some head bakers work at two locations, so we need … a system that defaults
 *  to a single location but has the option to add extra locations where the
 *  head baker could work. I would like to add this as a feature that the user
 *  (head baker) can add him or herself."
 *
 * `device_pins.site_id` remains the HOME venue. `device_pin_sites` holds the
 * extras, added by the baker from the iPad. Self-service was the owner's
 * decision, on the condition that every addition is logged and reversible —
 * each row records when and by whom, head office can list them, and deleting
 * the row revokes it.
 *
 * A token's venues are decided HERE and signed into it. The client never says
 * which venues it may use; it only chooses among the ones the token carries.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../config/database.js';
import { devicePinSites, devicePins, sites } from '../../db/schema/index.js';
import { hashPassword, verifyPassword } from '../../shared/auth/password.js';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { requireRole } from '../../shared/middleware/require-role.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

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

const addSiteSchema = z.object({ siteId: z.string().uuid() });

/** The pin id carried by a PIN token, or null for a full user login. */
function pinIdOf(userId: string): string | null {
  return userId.startsWith('pin:') ? userId.slice(4) : null;
}

export async function pinAuthRoutes(app: FastifyInstance) {
  /**
   * Every venue this PIN may act for: its home venue first, then the extras it
   * has been granted, each named. Ordered with home first because that is the
   * one the sign-in screen offers by default.
   */
  async function venuesFor(pin: {
    id: string;
    siteId: string | null;
    companyId: string;
  }): Promise<Array<{ id: string; name: string; isHome: boolean }>> {
    const db = getDb();
    const extras = await db
      .select({ siteId: devicePinSites.siteId })
      .from(devicePinSites)
      .where(eq(devicePinSites.devicePinId, pin.id));
    const ids = [...new Set([pin.siteId, ...extras.map((e) => e.siteId)].filter(Boolean))] as string[];
    if (ids.length === 0) return [];
    const rows = await db.query.sites.findMany({
      where: and(eq(sites.companyId, pin.companyId), inArray(sites.id, ids)),
      columns: { id: true, name: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    return ids
      .filter((id) => byId.has(id))
      .map((id) => ({ id, name: byId.get(id)!, isHome: id === pin.siteId }))
      .sort((a, b) => (a.isHome === b.isHome ? a.name.localeCompare(b.name) : a.isHome ? -1 : 1));
  }

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
        const venues = await venuesFor(row);
        // The venue this token acts for. A PIN with extras does NOT get one
        // chosen for it — the screen asks (item 1) — but the token still has
        // to carry something, so it carries home until the baker chooses.
        const activeSiteId = row.siteId;
        const token = app.jwt.sign(
          {
            userId: `pin:${row.id}`,
            companyId: row.companyId,
            email: `${row.label}@pin.local`,
            roles: row.roles,
            siteId: activeSiteId,
            // Signed here, never sent by the client. `canAccessSite` reads it,
            // so a baker can switch venue mid-shift without re-authenticating
            // and without the client being able to widen its own scope.
            siteIds: venues.map((v) => v.id),
            label: row.label,
          },
          { expiresIn: '12h' },
        );
        // The site NAME travels with the login (Aug-2026 feedback, E-1/B-5).
        // The id alone is not something a venue screen can put in front of a
        // baker, and the client discarding this response is precisely how a
        // South London iPad ended up booking to Birmingham.
        return {
          success: true,
          data: {
            token,
            user: {
              label: row.label,
              roles: row.roles,
              siteId: activeSiteId,
              siteName: venues.find((v) => v.id === activeSiteId)?.name ?? null,
              /** Every venue this PIN may work at. One entry ⇒ no choice to make. */
              sites: venues,
            },
          },
        };
      }
    }
    return reply.status(401).send({ success: false, error: 'invalid_pin' });
  });

  // ── The signed-in baker's own venues (item 1) ──────────────────────────
  app.get('/device-pins/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = getAuthUser(request);
    const pinId = pinIdOf(user.userId);
    if (!pinId) {
      return reply.status(400).send({ success: false, error: 'not_a_pin_login' });
    }
    const db = getDb();
    const pin = await db.query.devicePins.findFirst({ where: eq(devicePins.id, pinId) });
    if (!pin) return reply.status(404).send({ success: false, error: 'pin_not_found' });

    const mine = await venuesFor(pin);
    const mineIds = new Set(mine.map((v) => v.id));
    // What "Add location" can offer: every active venue not already on the
    // list. Computed server-side so the screen cannot offer something the
    // add endpoint would refuse.
    const all = await db.query.sites.findMany({
      where: eq(sites.companyId, pin.companyId),
      columns: { id: true, name: true, isActive: true },
    });
    const available = all
      .filter((s) => s.isActive && !mineIds.has(s.id))
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { success: true, data: { label: pin.label, sites: mine, available } };
  });

  app.post('/device-pins/me/sites', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = addSiteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'invalid_request' });
    }
    const user = getAuthUser(request);
    const pinId = pinIdOf(user.userId);
    if (!pinId) return reply.status(400).send({ success: false, error: 'not_a_pin_login' });

    const db = getDb();
    const pin = await db.query.devicePins.findFirst({ where: eq(devicePins.id, pinId) });
    if (!pin) return reply.status(404).send({ success: false, error: 'pin_not_found' });

    const site = await db.query.sites.findFirst({
      where: and(eq(sites.id, parsed.data.siteId), eq(sites.companyId, pin.companyId)),
    });
    if (!site) return reply.status(404).send({ success: false, error: 'site_not_found' });
    if (!site.isActive) {
      return reply.status(400).send({ success: false, error: 'site_not_active' });
    }

    if (site.id !== pin.siteId) {
      await db
        .insert(devicePinSites)
        .values({
          companyId: pin.companyId,
          devicePinId: pin.id,
          siteId: site.id,
          addedVia: 'SELF',
          addedBy: pin.label,
        })
        // Adding the same venue twice is a double-tap, not a second grant.
        .onConflictDoNothing();
    }

    // ⚠️ The token is NOT reissued here, so the new venue is usable from the
    // baker's next sign-in. Minting a wider token on the strength of a request
    // made with the narrower one is how a scope becomes self-extending; a PIN
    // tap is cheap and it is what the screen tells them to do.
    return { success: true, data: { sites: await venuesFor(pin), tokenRefreshNeeded: true } };
  });

  app.delete('/device-pins/me/sites/:siteId', { preHandler: requireAuth }, async (request, reply) => {
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(request.params);
    const user = getAuthUser(request);
    const pinId = pinIdOf(user.userId);
    if (!pinId) return reply.status(400).send({ success: false, error: 'not_a_pin_login' });

    const db = getDb();
    const pin = await db.query.devicePins.findFirst({ where: eq(devicePins.id, pinId) });
    if (!pin) return reply.status(404).send({ success: false, error: 'pin_not_found' });
    // The home venue is not one of the extras and cannot be dropped from here
    // — that is head office's decision, not a tidy-up on an iPad.
    if (siteId === pin.siteId) {
      return reply.status(400).send({ success: false, error: 'cannot_remove_home_site' });
    }
    await db
      .delete(devicePinSites)
      .where(and(eq(devicePinSites.devicePinId, pin.id), eq(devicePinSites.siteId, siteId)));
    return { success: true, data: { sites: await venuesFor(pin) } };
  });

  // ── Head office: see and revoke what bakers granted themselves ─────────
  app.get(
    '/device-pins',
    { preHandler: [requireAuth, requireRole(['site_manager'])] },
    async () => {
      const db = getDb();
      const companyId = getSingletonCompanyId();
      const pins = await db.query.devicePins.findMany({
        where: eq(devicePins.companyId, companyId),
      });
      const data = [];
      for (const pin of pins) {
        const extras = await db
          .select({
            siteId: devicePinSites.siteId,
            addedVia: devicePinSites.addedVia,
            addedBy: devicePinSites.addedBy,
            createdAt: devicePinSites.createdAt,
          })
          .from(devicePinSites)
          .where(eq(devicePinSites.devicePinId, pin.id));
        data.push({
          id: pin.id,
          label: pin.label,
          roles: pin.roles,
          isActive: pin.isActive,
          homeSiteId: pin.siteId,
          sites: await venuesFor(pin),
          // The audit trail: who added what, when, and whether it was
          // self-service or granted.
          grants: extras,
        });
      }
      return { success: true, data };
    },
  );

  app.delete(
    '/device-pins/:id/sites/:siteId',
    { preHandler: [requireAuth, requireRole(['site_manager'])] },
    async (request) => {
      const { id, siteId } = z
        .object({ id: z.string().uuid(), siteId: z.string().uuid() })
        .parse(request.params);
      await getDb()
        .delete(devicePinSites)
        .where(and(eq(devicePinSites.devicePinId, id), eq(devicePinSites.siteId, siteId)));
      return { success: true, data: { id, siteId } };
    },
  );

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
