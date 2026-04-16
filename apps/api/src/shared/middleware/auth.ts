import type { FastifyReply, FastifyRequest } from 'fastify';

/** JWT payload shape */
export interface JwtPayload {
  userId: string;
  companyId: string;
  email: string;
  roles: string[];
}

/**
 * Pre-handler hook that verifies the JWT and attaches decoded payload
 * to request.user. Returns 401 if token is missing or invalid.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    const decoded = await request.jwtVerify<JwtPayload>();
    // Attach to request for downstream use
    (request as any).user = decoded;
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
