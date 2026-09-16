import type { FastifyReply, FastifyRequest } from 'fastify';
import { getSingletonCompanyId } from '../auth/company.js';

/** JWT payload shape */
export interface JwtPayload {
  userId: string;
  companyId: string;
  email: string;
  roles: string[];
  /**
   * Set on PIN-login tokens (spec §A11): the venue this token is acting for.
   *
   * Since Sept-2026 (item 1) a PIN may be allowed to work at several venues,
   * and the baker chooses which at sign-in. This claim is THAT CHOICE — the
   * venue everything filed with this token is attributed to — not necessarily
   * the PIN's home venue.
   */
  siteId?: string | null;
  /**
   * Every venue this PIN is allowed to act for: its home venue plus any extras
   * (`device_pin_sites`). Present only on PIN tokens issued after item 1.
   *
   * ⚠️ `siteId` alone is NOT enough to authorise against any more. A baker who
   * signed in at London East and then switches to London South mid-shift keeps
   * the same token; without this list the switch would be silently refused, or
   * — far worse, if the client were trusted instead — a token could act on a
   * venue nobody ever granted it.
   */
  siteIds?: string[] | null;
  label?: string;
}

/**
 * True if the user may act on `siteId`.
 *
 * Admins and unscoped (full user) tokens are site-agnostic. A PIN token is
 * limited to the venues it was actually granted: its chosen `siteId` plus
 * every entry in `siteIds`.
 *
 * The list is read from the TOKEN, which the server signed at login from
 * `device_pin_sites`. A client cannot widen it, and revoking a venue takes
 * effect on the baker's next sign-in — the 12-hour token life is the bound on
 * how long a revoked venue stays usable, which is the same bound that already
 * applies to deactivating the PIN itself.
 */
export function canAccessSite(user: JwtPayload, siteId: string): boolean {
  if (user.roles?.includes('admin')) return true;
  if (user.siteId == null) return true; // unscoped (full user) — site-agnostic
  if (user.siteId === siteId) return true;
  return Array.isArray(user.siteIds) && user.siteIds.includes(siteId);
}

/**
 * Pre-handler hook that verifies the JWT and attaches decoded payload
 * to request.user. Returns 401 if token is missing or invalid.
 *
 * Single-tenant: the JWT's `companyId` claim is no longer trusted for
 * authorization. We accept any signature-valid token and overwrite
 * `companyId` with the singleton, so service code that filters by
 * `user.companyId` always reads the singleton's id.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    const decoded = await request.jwtVerify<JwtPayload>();
    const singletonCompanyId = getSingletonCompanyId();
    (request as any).user = {
      ...decoded,
      companyId: singletonCompanyId,
    };
  } catch {
    return reply.status(401).send({
      success: false,
      error: 'Unauthorized — valid JWT required',
    });
  }
}

/**
 * Helper to extract the authenticated user from a request.
 * Should only be called after requireAuth has run.
 */
export function getAuthUser(request: FastifyRequest): JwtPayload {
  return (request as any).user as JwtPayload;
}
