/**
 * Resolves the signed add-to-cart links in emails (runbook section 7 step 4)
 * for the storefront: `GET /storefront/email-links/cart?t=<token>` returns
 * the variant and quantity the token names, or 410 when the token is
 * tampered with, expired or names a product that is no longer for sale. The
 * storefront adds the line to its own cart; no account access is granted.
 *
 * Trade prices are not applied (BLOCKERS B3): the storefront does not use
 * per-customer prices today and their VAT basis is unconfirmed.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { products } from '../../../db/schema/index.js';
import { apiKeyAuth } from '../../../shared/middleware/api-key.js';
import { verifySignedLink } from '../lib/tokens.js';

export async function emailCartLinkRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:read']));

  app.get('/storefront/email-links/cart', async (request, reply) => {
    const { t } = request.query as { t?: string };
    const payload = t ? verifySignedLink<{ p?: string; q?: number; c?: string }>(t) : null;
    if (!payload?.p || typeof payload.p !== 'string') {
      return reply.status(410).send({ success: false, error: 'This link has expired.' });
    }
    const [product] = await getDb()
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, payload.p), eq(products.isPublished, true), isNull(products.deletedAt)))
      .limit(1)
      .catch(() => []);
    if (!product) return reply.status(410).send({ success: false, error: 'This product is no longer available.' });
    const quantity = Number.isInteger(payload.q) && payload.q! >= 1 && payload.q! <= 99 ? payload.q! : 1;
    return { success: true, data: { productId: product.id, quantity } };
  });
}
