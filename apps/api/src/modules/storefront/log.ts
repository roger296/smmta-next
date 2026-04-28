/**
 * Per-request scoped helpers for the storefront API surface.
 *
 * The Fastify root logger already ships JSON to stdout; this module adds:
 *
 *   - `requestIdHook(app)`: reads `X-Request-Id` off every inbound
 *     request and binds it to the per-request logger so every line a
 *     storefront route emits carries the same id. Missing ids are
 *     generated locally so traces never break.
 *
 *   - `getRequestLogger(request)`: short-cut for handlers + services
 *     that want a typed reference to the bound logger.
 *
 * Wiring is done from `app.ts` so this module stays focused on the
 * storefront surface alone — admin / orders / GL routes inherit the
 * default Fastify logger (which is also fine, just no requestId).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

declare module 'fastify' {
  interface FastifyRequest {
    requestId?: string;
  }
}

/** Register a Fastify hook on every request whose URL begins with
 *  `/api/v1/storefront`. Picks the inbound `X-Request-Id` if present;
 *  otherwise mints a fresh uuid. The id is mirrored back on the
 *  response so the storefront can correlate. */
export async function registerStorefrontRequestId(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/storefront')) return;
    const inbound = request.headers[REQUEST_ID_HEADER];
    const id =
      typeof inbound === 'string' && inbound.length > 0
        ? inbound
        : Array.isArray(inbound) && inbound[0]
          ? inbound[0]
          : randomUUID();
    request.requestId = id;
    // Re-bind the per-request log child so every line emitted from a
    // storefront handler carries `requestId` automatically.
    request.log = request.log.child({ requestId: id });
    void reply.header(REQUEST_ID_HEADER, id);
  });
}

/** Convenience: typed accessor for handler/service code. */
export function getRequestLogger(request: FastifyRequest) {
  return request.log;
}
