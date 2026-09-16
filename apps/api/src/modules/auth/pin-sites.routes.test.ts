/**
 * Adding a second venue to your own PIN (Sept-2026 user testing, item 1).
 *
 * "I would like to add this as a feature that the user (head baker) can add him
 *  or herself - a button on the ipad app marked 'add location'."
 *
 * Self-service was the owner's decision, on the condition that every addition
 * is logged and reversible. These walk the whole round trip against the built
 * app: the grant, what the next sign-in carries, what head office can see and
 * revoke, and — the part that matters most — that the scope cannot grow from
 * the client side.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { closeDatabase, getDb } from '../../config/database.js';
import { devicePinSites, devicePins, sites } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { hashPassword } from '../../shared/auth/password.js';

const COMPANY = getSingletonCompanyId();
const SLUGS = ['ms-home', 'ms-second', 'ms-third', 'ms-closed'];
const LABEL = 'Multi Site Baker';

let app: FastifyInstance;
let adminJwt: string;
let homeId: string;
let secondId: string;
let thirdId: string;
let closedId: string;
let pinId: string;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.delete(devicePins).where(eq(devicePins.label, LABEL));
  await db.delete(sites).where(inArray(sites.slug, SLUGS));
}

/** Sign in with the PIN and return the token plus what the screen is told. */
async function pinLogin(): Promise<{
  token: string;
  sites: Array<{ id: string; name: string; isHome: boolean }>;
}> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/pin-login',
    payload: { pin: '778811' },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  return { token: body.data.token, sites: body.data.user.sites };
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
  app = await buildApp();
  await app.ready();
  adminJwt = app.jwt.sign({
    userId: 'u',
    companyId: COMPANY,
    email: 't@a.invalid',
    roles: ['admin'],
  });
  await cleanup();

  const db = getDb();
  const mk = async (slug: string, name: string, isActive = true) => {
    const [s] = await db
      .insert(sites)
      .values({ companyId: COMPANY, slug, name, canonicalName: name, isActive })
      .returning();
    return s!.id;
  };
  homeId = await mk('ms-home', 'MS Home');
  secondId = await mk('ms-second', 'MS Second');
  thirdId = await mk('ms-third', 'MS Third');
  closedId = await mk('ms-closed', 'MS Closed', false);

  const [pin] = await db
    .insert(devicePins)
    .values({
      companyId: COMPANY,
      siteId: homeId,
      label: LABEL,
      pinHash: await hashPassword('778811'),
      roles: ['head_baker'],
    })
    .returning();
  pinId = pin!.id;
});

beforeEach(async () => {
  await getDb().delete(devicePinSites).where(eq(devicePinSites.devicePinId, pinId));
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await closeDatabase();
});

describe('a PIN with no extra venues behaves exactly as before', () => {
  it('signs in to its home venue, with no choice to make', async () => {
    const { sites: venues } = await pinLogin();
    expect(venues).toEqual([{ id: homeId, name: 'MS Home', isHome: true }]);
  });
});

describe('adding a venue from the iPad', () => {
  it('grants it, and the next sign-in offers both', async () => {
    const { token } = await pinLogin();
    const add = await app.inject({
      method: 'POST',
      url: '/api/v1/device-pins/me/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { siteId: secondId },
    });
    expect(add.statusCode).toBe(200);

    const { sites: venues } = await pinLogin();
    expect(venues.map((v) => v.name)).toEqual(['MS Home', 'MS Second']);
    // Home first — it is the one the sign-in screen offers by default.
    expect(venues[0]!.isHome).toBe(true);
  });

  it('signs the granted venues into the token', async () => {
    const { token } = await pinLogin();
    await app.inject({
      method: 'POST',
      url: '/api/v1/device-pins/me/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { siteId: secondId },
    });

    const { token: next } = await pinLogin();
    const claims = app.jwt.decode(next) as { siteId: string; siteIds: string[] };
    expect(claims.siteId).toBe(homeId);
    expect(claims.siteIds.sort()).toEqual([homeId, secondId].sort());
  });

  it('is a double-tap, not a second grant, when repeated', async () => {
    const { token } = await pinLogin();
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/device-pins/me/sites',
        headers: { authorization: `Bearer ${token}` },
        payload: { siteId: secondId },
      });
    }
    const rows = await getDb()
      .select()
      .from(devicePinSites)
      .where(eq(devicePinSites.devicePinId, pinId));
    expect(rows).toHaveLength(1);
  });

  it('offers only venues not already on the list', async () => {
    const { token } = await pinLogin();
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/device-pins/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const available = me.json().data.available as Array<{ id: string; name: string }>;
    expect(available.map((s) => s.id)).toContain(secondId);
    // Its own home is not on offer…
    expect(available.map((s) => s.id)).not.toContain(homeId);
    // …and neither is a closed venue.
    expect(available.map((s) => s.id)).not.toContain(closedId);
  });

  it('refuses a venue that is closed', async () => {
    const { token } = await pinLogin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/device-pins/me/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { siteId: closedId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('does NOT reissue a wider token on the strength of the narrower one', async () => {
    // Minting a wider token from a request made with the narrower one is how a
    // scope becomes self-extending. The new venue is usable from the next PIN
    // tap, which is cheap and is what the screen tells the baker to do.
    const { token } = await pinLogin();
    const before = (app.jwt.decode(token) as { siteIds: string[] }).siteIds;

    const add = await app.inject({
      method: 'POST',
      url: '/api/v1/device-pins/me/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { siteId: secondId },
    });
    expect(add.json().data.tokenRefreshNeeded).toBe(true);
    // The token in hand is unchanged — it cannot have grown.
    expect((app.jwt.decode(token) as { siteIds: string[] }).siteIds).toEqual(before);
  });
});

describe('removing a venue', () => {
  it('lets a baker drop one they added', async () => {
    const { token } = await pinLogin();
    await app.inject({
      method: 'POST',
      url: '/api/v1/device-pins/me/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { siteId: secondId },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/device-pins/me/sites/${secondId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.sites.map((s: { id: string }) => s.id)).toEqual([homeId]);
  });

  it('refuses to drop the home venue', async () => {
    // That is head office's decision, not a tidy-up on an iPad — and a PIN
    // with no venues at all could file nothing.
    const { token } = await pinLogin();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/device-pins/me/sites/${homeId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('cannot_remove_home_site');
  });
});

describe('head office can see and undo it', () => {
  it('lists the grant with who added it and when', async () => {
    const { token } = await pinLogin();
    await app.inject({
      method: 'POST',
      url: '/api/v1/device-pins/me/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { siteId: thirdId },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/device-pins',
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(res.statusCode).toBe(200);
    const mine = res.json().data.find((p: { id: string }) => p.id === pinId);
    expect(mine.sites.map((s: { name: string }) => s.name)).toEqual(['MS Home', 'MS Third']);
    expect(mine.grants).toHaveLength(1);
    expect(mine.grants[0].addedVia).toBe('SELF');
    expect(mine.grants[0].addedBy).toBe(LABEL);
    expect(mine.grants[0].createdAt).toBeTruthy();
  });

  it('revokes a venue a baker granted themselves', async () => {
    const { token } = await pinLogin();
    await app.inject({
      method: 'POST',
      url: '/api/v1/device-pins/me/sites',
      headers: { authorization: `Bearer ${token}` },
      payload: { siteId: thirdId },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/device-pins/${pinId}/sites/${thirdId}`,
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(res.statusCode).toBe(200);
    const { sites: venues } = await pinLogin();
    expect(venues.map((v) => v.id)).toEqual([homeId]);
  });

  it('is not readable by a head baker', async () => {
    // The list names every PIN in the company and which venues each can reach.
    const { token } = await pinLogin();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/device-pins',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
