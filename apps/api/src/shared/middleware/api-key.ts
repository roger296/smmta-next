/**
 * Fastify preHandler factory: `apiKeyAuth([scope, ...])`.
 *
 * Verifies a `Authorization: Bearer <raw key>` header against the
 * `api_keys` table, attaches `{ companyId, scopes, keyId, prefix }` to
 * `request.apiKey`, and rejects:
 *   - 401 with `WWW-Authenticate: Bearer` on missing / malformed /
 *     unknown / revoked / failed-verification key
 *   - 403 when the required scopes are missing
 *
 * `last_used_at` is updated asynchronously (fire-and-forget) so it
 * never blocks the request that's already authenticated.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { getDb } from '../../config/database.js';
import { apiKeys } from '../../db/schema/index.js';
import { parseRawKey, verifySecret } from '../auth/api-key.js';

export interface ApiKeyContext {
  companyId: string;
  scopes: string[];
  keyId: string;
  prefix: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyContext;
  }
}

const sendUnauthorized = (reply: FastifyReply, error: string) =>
  reply
    .header('WWW-Authenticate', 'Bearer')
    .status(401)
    .send({ success: false, error });

const sendForbidden = (reply: FastifyReply, error: string) =>
  reply.status(403).send({ success: false, error });

/**
 * Build a preHandler that requires a valid api key with all of the
 * given scopes. Pass an empty array (or omit) to require any valid key
 * with no scope check.
 */
export function apiKeyAuth(requiredScopes: string[] = []): preHandlerHookHandler {
  return async function apiKeyAuthHandler(request: FastifyRequest, reply: FastifyReply) {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return sendUnauthorized(reply, 'Missing Bearer token');
    }
    const raw = auth.slice('Bearer '.length).trim();
    const parsed = parseRawKey(raw);
    if (!parsed) {
      return sendUnauthorized(reply, 'Malformed API key');
    }

    const db = getDb();
    const row = await db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.prefix, parsed.prefix), isNull(apiKeys.deletedAt)),
    });

    if (!row) return sendUnauthorized(reply, 'Unknown API key');
    if (row.revokedAt) return sendUnauthorized(reply, 'API key revoked');

    const ok = await verifySecret(parsed.secret, row.keyHash);
    if (!ok) return sendUnauthorized(reply, 'Invalid API key');

    if (requiredScopes.length > 0) {
      const have = new Set(row.scopes);
      const missing = requiredScopes.filter((s) => !have.has(s));
      if (missing.length > 0) {
        return sendForbidden(reply, `Missing required scope(s): ${missing.join(', ')}`);
      }
    }

    request.apiKey = {
      companyId: row.companyId,
      scopes: row.scopes,
      keyId: row.id,
      prefix: row.prefix,
    };

    // Best-effort `last_used_at` refresh. We deliberately do not await
    // this — a slow update mustn't keep the request hanging — and we
    // swallow errors because failure to update the timestamp is not a
    // reason to reject the request.
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
      .catch((err) => {
        request.log.warn({ err, keyId: row.id }, 'Failed to update api_keys.last_used_at');
      });
  };
}

/** Helper for typed access from inside a route handler. Throws if used
 *  on a request that didn't go through `apiKeyAuth`. */
export function getApiKeyContext(request: FastifyRequest): ApiKeyContext {
  if (!request.apiKey) {
    throw new Error('apiKeyAuth must run before getApiKeyContext');
  }
  return request.apiKey;
}
