import type { FastifyReply, FastifyRequest } from 'fastify';
import { getSingletonCompanyId } from '../auth/company.js';

/** JWT payload shape */
export interface JwtPayload {
  userId: string;
  companyId: string;
  email: string;
  roles: string[];
  /** Set on PIN-login tokens (spec §A11): the site the shared iPad is bound to.
   *  Scopes the head-baker form to its own site. Absent on full user logins. */
  siteId?: string | null;
  label?: string;
}

/** True if the user may act on `siteId`: admins (no siteId scope) may act on any
 *  site; a site-scoped token (e.g. a head-baker PIN) only on its own site. */
export function canAccessSite(user: JwtPayload, siteId: string): boolean {
  if (user.roles?.includes('admin')) return true;
  if (user.siteId == null) return true; // unscoped (full user) — site-agnostic
  return user.siteId === siteId;
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
