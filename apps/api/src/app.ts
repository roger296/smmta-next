import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { getEnv } from './config/env.js';
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
import { siteRoutes } from './modules/sites/site.routes.js';
import { stockRoutes } from './modules/stock/stock.routes.js';
import { xeroAccountMapRoutes } from './modules/xero/xero-account-map.routes.js';
import { reorderRoutes } from './modules/reorder/reorder.routes.js';
import { goodsInRoutes } from './modules/goods-in/goods-in.routes.js';
import { stockTakeRoutes } from './modules/stock-take/stock-take.routes.js';
import { stockTakeLiteRoutes } from './modules/stocktake-lite/stocktake-lite.routes.js';
import { squareRoutes } from './modules/square/square.routes.js';
import { catalogueSyncRoutes } from './modules/catalogue-sync/catalogue-sync.routes.js';
import { recipeRoutes } from './modules/recipes/recipe.routes.js';
import { sessionConsumptionRoutes } from './modules/consumption/session-consumption.routes.js';
import { reportRoutes } from './modules/reports/reports.routes.js';
import { imageCaptureRoutes } from './modules/images/image-capture.routes.js';
import { pinAuthRoutes } from './modules/auth/pin.routes.js';
import { mcpRoutes } from './modules/mcp/mcp.routes.js';
import { dropshipSupplierRoutes } from './modules/suppliers/supplier-dropship.routes.js';
import { supplierOrdersRoutes } from './modules/suppliers/supplier-orders.routes.js';
import {
  storefrontReadRoutes,
  storefrontWriteRoutes,
} from './modules/storefront/storefront.routes.js';
import { notifyMeRoutes } from './modules/storefront/notify-me.routes.js';
import { registerStorefrontRequestId } from './modules/storefront/log.js';

export async function buildApp() {
  const env = getEnv();

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

  // Auto-Stock: multi-site management (spec §A5).
  await app.register(siteRoutes, { prefix: '/api/v1' });

  // Auto-Stock: per-site stock ledger — levels, valuation, adjust, transfer.
  await app.register(stockRoutes, { prefix: '/api/v1' });

  // Auto-Stock: Xero GL account/tax map admin (spec §A8).
  await app.register(xeroAccountMapRoutes, { prefix: '/api/v1' });

  // Auto-Stock: automatic reordering — proposals, approve/place, sweep (spec §A7).
  await app.register(reorderRoutes, { prefix: '/api/v1' });

  // Auto-Stock: goods-in / receiving against the per-site ledger (spec §A7).
  await app.register(goodsInRoutes, { prefix: '/api/v1' });

  // Auto-Stock: stock-takes — count vs book, true-up + adjustment (spec §A6).
  await app.register(stockTakeRoutes, { prefix: '/api/v1' });

  // Auto-Stock: stock-take-lite — the standalone iPad stock-take demo (P26).
  // Decoupled from products/ledger/Xero; access-code gated, not JWT.
  await app.register(stockTakeLiteRoutes, { prefix: '/api/v1' });

  // Auto-Stock: Square sales → automatic stock decrement (spec §A8).
  await app.register(squareRoutes, { prefix: '/api/v1' });

  // Auto-Stock: shared product catalogue with BumbleBee (spec §A4).
  await app.register(catalogueSyncRoutes, { prefix: '/api/v1' });

  // Auto-Stock: recipes / BOM — expected consumption = recipe × covers (spec §A6).
  await app.register(recipeRoutes, { prefix: '/api/v1' });

  // Auto-Stock: head-baker end-of-session consumption form (spec §A6).
  await app.register(sessionConsumptionRoutes, { prefix: '/api/v1' });

  // Auto-Stock: expected/actual/counted variance + wastage + food-cost reports (spec §A6).
  await app.register(reportRoutes, { prefix: '/api/v1' });

  // Auto-Stock: image captures for the AI groundwork set (spec §A10).
  await app.register(imageCaptureRoutes, { prefix: '/api/v1' });

  // Auto-Stock: shared-device PIN login for the iPad PWA (spec §A11).
  await app.register(pinAuthRoutes, { prefix: '/api/v1' });

  // Auto-Stock: MCP server for Claude / Cowork — mounted at root (/mcp +
  // /.well-known/oauth-protected-resource), spec §A9.
  await app.register(mcpRoutes);

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

  return app;
}
