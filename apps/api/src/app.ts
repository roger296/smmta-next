import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { getEnv } from './config/env.js';
import { errorHandler } from './shared/middleware/error-handler.js';
import { productRoutes } from './modules/products/product.routes.js';
import { stockItemRoutes } from './modules/products/stock-item.routes.js';
import { referenceRoutes } from './modules/products/reference.routes.js';
import { supplierRoutes } from './modules/purchasing/supplier.routes.js';
import { purchasingRoutes } from './modules/purchasing/purchasing.routes.js';
import { customerRoutes } from './modules/customers/customer.routes.js';
import { orderRoutes } from './modules/orders/order.routes.js';
import { integrationRoutes } from './modules/orders/integration.routes.js';
import { apiKeyAdminRoutes } from './modules/admin/api-keys.routes.js';
import { storefrontReadRoutes } from './modules/storefront/storefront.routes.js';

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

  // Storefront: public read surface, gated by apiKeyAuth (Prompt 4).
  await app.register(storefrontReadRoutes, { prefix: '/api/v1' });

  return app;
}
