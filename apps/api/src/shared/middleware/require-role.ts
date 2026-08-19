/**
 * Role guard (Aug-2026 feedback set, defect E-4).
 *
 * "Accidental booking logged 100kg to Birmingham; requested an undo timer **or
 * role-based permission locks**." There was no role guard beside `requireAuth`
 * at all: any signature-valid token — including a head-baker PIN on a shared
 * venue iPad — could approve a stock-take or edit a cost.
 *
 * The split (locked decision 5, 19 Aug 2026 — default, confirm with owners):
 *
 *   head_baker    record goods-in, counts, and consumption
 *   site_manager  the above, plus approve a stock-take, reverse a goods-in
 *                 receipt, and edit product costs
 *   admin         everything
 *
 * `admin` is implicit everywhere: a guard that lists `site_manager` accepts an
 * admin too, so no route has to remember to say so.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getAuthUser, type JwtPayload } from './auth.js';

export type Role = 'head_baker' | 'site_manager' | 'admin';

/** Admins pass every guard without being named in it. */
export const ALWAYS_ALLOWED: Role = 'admin';

export function hasRole(user: Pick<JwtPayload, 'roles'>, allowed: readonly Role[]): boolean {
  const roles = user.roles ?? [];
  if (roles.includes(ALWAYS_ALLOWED)) return true;
  return allowed.some((r) => roles.includes(r));
}

/**
 * A `preHandler` that 403s unless the caller holds one of `allowed`.
 *
 * The message names the roles that WOULD work, because it is surfaced to a
 * baker on a venue screen through F2's error banner: "not allowed" with no
 * explanation is the kind of dead end that ends in a phone call to head
 * office.
 */
export function requireRole(allowed: readonly Role[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply) {
    const user = getAuthUser(request);
    if (!user) {
      return reply.status(401).send({ success: false, error: 'Unauthorized — valid JWT required' });
    }
    if (hasRole(user, allowed)) return;
    return reply.status(403).send({
      success: false,
      error: `This needs ${describeRoles(allowed)}. You are signed in as ${describeRoles((user.roles ?? []) as Role[]) || 'a user with no role'}.`,
    });
  };
}

function describeRoles(roles: readonly string[]): string {
  const pretty = roles.map((r) => r.replace(/_/g, ' '));
  if (pretty.length === 0) return '';
  if (pretty.length === 1) return `a ${pretty[0]}`;
  return `a ${pretty.slice(0, -1).join(', ')} or ${pretty[pretty.length - 1]}`;
}

/**
 * A `preHandler` that 403s when the request writes to a site the caller's
 * token is not bound to (defect E-1's belt, to the site-binding braces).
 *
 * A PIN bound to London South must not be able to produce a booking recorded
 * against Birmingham, whatever the client sends. `site_manager` and `admin`
 * may cross sites deliberately — someone has to be able to fix a mis-booking
 * from the office.
 */
export function requireBoundSite(readSiteId: (request: FastifyRequest) => string | undefined) {
  return async function siteGuard(request: FastifyRequest, reply: FastifyReply) {
    const user = getAuthUser(request);
    if (!user) {
      return reply.status(401).send({ success: false, error: 'Unauthorized — valid JWT required' });
    }
    // An unscoped token (a full user login) is site-agnostic by design.
    if (user.siteId == null) return;
    if (hasRole(user, ['site_manager'])) return;

    const target = readSiteId(request);
    if (!target || target === user.siteId) return;

    return reply.status(403).send({
      success: false,
      error:
        'This device is set up for a different venue. Ask a site manager to book to another site, or switch the device binding.',
    });
  };
}
