import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { getEnv } from './config/env.js';
import { initSentry } from './shared/observability/sentry.js';
import { errorHandler } from './shared/middleware/error-handler.js';
import { productRoutes } from './modules/products/product.routes.js';
import { productGroupRoutes } from './modules/products/product-group.routes.js';
import { stockItemRoutes } from './modules/products/stock-item.routes.js';
import { referenceRoutes } from './modules/products/reference.routes.js';
import { supplierRoutes } from './modules/purchasing/supplier.routes.js';
import { purchasingRoutes } from './modules/purchasing/purchasing.routes.js';
import { customerRoutes } from './modules/customers/customer.routes.js';
import { orderRoutes } from './modules/orders/order.routes.js';
import { integrationRoutes } from './modules/orders/integration.routes.js';
import { apiKeyAdminRoutes } from './modules/admin/api-keys.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { channelRoutes } from './modules/channels/channel.routes.js';
import { dropshipSupplierRoutes } from './modules/suppliers/supplier-dropship.routes.js';
import { supplierOrdersRoutes } from './modules/suppliers/supplier-orders.routes.js';
import {
  storefrontReadRoutes,
  storefrontWriteRoutes,
} from './modules/storefront/storefront.routes.js';
import { notifyMeRoutes } from './modules/storefront/notify-me.routes.js';
import { registerStorefrontRequestId } from './modules/storefront/log.js';
import { identityRoutes } from './modules/identity/identity.routes.js';
import { inboundRoutes } from './modules/inbound/inbound.routes.js';
import { poolsRoutes } from './modules/inbound/pools.routes.js';
import { interestRoutes } from './modules/interest/interest.routes.js';
import { comingSoonRoutes } from './modules/interest/coming-soon.routes.js';
import { prospectiveRoutes } from './modules/interest/prospective.routes.js';
import {
  preorderStorefrontRoutes,
  preorderAdminRoutes,
  mollieWebhookRoutes,
} from './modules/payments/payment.routes.js';
import { chatRoutes } from './modules/agent/chat.routes.js';
import { sendgridWebhookRoutes, unsubscribeRoutes } from './modules/messaging/messaging.routes.js';
import { approvalRoutes } from './modules/approval/approval.routes.js';
import { subscriptionRoutes } from './modules/subscriptions/subscription.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { digestRoutes } from './modules/digest/digest.routes.js';

export async function buildApp() {
  const env = getEnv();
  initSentry('api');

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport: env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: env.JWT_SECRET });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'SMMTA-Next API',
        description: 'Stock Control & Order Handling — integrated with Luca General Ledger',
        version: '0.1.0',
      },
      servers: [{ url: `http://localhost:${env.PORT}` }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Global error handler
  app.setErrorHandler(errorHandler);

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  }));

  // Phase 2: Products & Stock
  await app.register(productRoutes, { prefix: '/api/v1' });
  await app.register(productGroupRoutes, { prefix: '/api/v1' });
  await app.register(stockItemRoutes, { prefix: '/api/v1' });
  await app.register(referenceRoutes, { prefix: '/api/v1' });

  // Phase 3: Purchasing & Suppliers
  await app.register(supplierRoutes, { prefix: '/api/v1' });
  await app.register(purchasingRoutes, { prefix: '/api/v1' });

  // Phase 4: Customers & Orders
  await app.register(customerRoutes, { prefix: '/api/v1' });
  await app.register(orderRoutes, { prefix: '/api/v1' });

  // Phase 5: Integrations, Bulk Ops, Year-End
  await app.register(integrationRoutes, { prefix: '/api/v1' });

  // Admin: service API key management (Prompt 2 of buldmeawebstore.md).
  await app.register(apiKeyAdminRoutes, { prefix: '/api/v1' });

  // Auth: email/password login. Issues the same JWT shape every other
  // route already consumes; only the issuance path is new.
  await app.register(authRoutes, { prefix: '/api/v1' });

  // Channels: per-product channel availability + per-channel pricing.
  await app.register(channelRoutes, { prefix: '/api/v1' });

  // Drop-ship suppliers: list/edit, test connection, poll-now, per-product mapping.
  await app.register(dropshipSupplierRoutes, { prefix: '/api/v1' });

  // Drop-ship: supplier-orders dashboard (admin: retry / cancel / mark-shipped).
  await app.register(supplierOrdersRoutes, { prefix: '/api/v1' });

  // Per-request requestId hook for storefront routes — binds an
  // X-Request-Id off the inbound headers (or mints one) and mirrors
  // it back on the response so the storefront can correlate logs +
  // Sentry events end to end. Registered before the storefront
  // routes so the hook runs ahead of every handler.
  await registerStorefrontRequestId(app);

  // Storefront: public read surface, gated by apiKeyAuth(['storefront:read']) (Prompt 4).
  await app.register(storefrontReadRoutes, { prefix: '/api/v1' });

  // Storefront: write surface (reservations, order commit, status, cancel),
  // gated by apiKeyAuth(['storefront:write']) (Prompt 5).
  await app.register(storefrontWriteRoutes, { prefix: '/api/v1' });

  // Storefront: notify-me when back in stock.
  await app.register(notifyMeRoutes, { prefix: '/api/v1' });

  // Storefront: customer identity (guest capture, provider resolution) + consent
  // (Prompt 3). Gated by the storefront api-key.
  await app.register(identityRoutes, { prefix: '/api/v1' });

  // Inbound shipments & presale stock pools (Prompt 4). Admin/operator surface.
  await app.register(inboundRoutes, { prefix: '/api/v1' });

  // Storefront-facing stock + pre-order pools for a SKU (PDP). Api-key gated.
  await app.register(poolsRoutes, { prefix: '/api/v1' });

  // Interest flags / demand-signal registry (Prompt 7). Storefront api-key gated.
  await app.register(interestRoutes, { prefix: '/api/v1' });
  await app.register(comingSoonRoutes, { prefix: '/api/v1' });
  await app.register(prospectiveRoutes, { prefix: '/api/v1' });

  // Pre-order payments (Prompt 6): storefront place/cancel, admin mark-paid,
  // and the thin Mollie webhook.
  await app.register(preorderStorefrontRoutes, { prefix: '/api/v1' });
  await app.register(preorderAdminRoutes, { prefix: '/api/v1' });
  await app.register(mollieWebhookRoutes, { prefix: '/api/v1' });

  // Sales agent chat (Prompt 8): SSE, storefront api-key gated.
  await app.register(chatRoutes, { prefix: '/api/v1' });

  // Email pipeline (Prompt 9): SendGrid event webhook + one-click unsubscribe.
  await app.register(sendgridWebhookRoutes, { prefix: '/api/v1' });
  await app.register(unsubscribeRoutes, { prefix: '/api/v1' });

  // Approval queue (Prompt 10): owner's inbox — approve/edit/reject, groups,
  // graduation, escalations. JWT-gated.
  await app.register(approvalRoutes, { prefix: '/api/v1' });

  // Subscriptions (Prompt 13): signup/pause/resume, apply credit. Storefront-gated.
  await app.register(subscriptionRoutes, { prefix: '/api/v1' });

  // Health (Prompt 15): /healthz for nginx / monitoring / systemd.
  await app.register(healthRoutes);

  // Admin digest (Prompt 15): the operator cockpit on demand. JWT-gated.
  await app.register(digestRoutes, { prefix: '/api/v1' });

  return app;
}
