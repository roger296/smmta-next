import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireAuth, getAuthUser } from '../../shared/middleware/auth.js';
import { MarketplaceService } from '../../integrations/marketplace/marketplace.service.js';
import { ShopifyConnector } from '../../integrations/marketplace/shopify.connector.js';
import { EbayConnector } from '../../integrations/marketplace/ebay.connector.js';
import { EtsyConnector } from '../../integrations/marketplace/etsy.connector.js';
import { CSVImportService } from './csv-import.service.js';
import { BulkOperationsService } from './bulk-operations.service.js';
import { YearEndService } from './year-end.service.js';

const marketplaceService = new MarketplaceService();
const csvImportService = new CSVImportService();
const bulkOpsService = new BulkOperationsService();
const yearEndService = new YearEndService();

export async function integrationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // ═══════════════════════════════════════════════════════════════
  // MARKETPLACE IMPORT
  // ═══════════════════════════════════════════════════════════════

  const importConfigSchema = z.object({
    channel: z.enum(['SHOPIFY', 'EBAY', 'ETSY']),
    shopDomain: z.string().optional(),
    accessToken: z.string(),
    sellerId: z.string().optional(),
    sinceId: z.string().optional(),
  });

  app.post('/import/marketplace', async (request, reply) => {
    const user = getAuthUser(request);
    const config = importConfigSchema.parse(request.body);

    let orders;

    switch (config.channel) {
      case 'SHOPIFY': {
        const connector = new ShopifyConnector({
          channelName: 'SHOPIFY',
          shopDomain: config.shopDomain,
          accessToken: config.accessToken,
        });
        orders = await connector.fetchOrders(config.sinceId);
        break;
      }
      case 'EBAY': {
        const connector = new EbayConnector({
          channelName: 'EBAY',
          accessToken: config.accessToken,
        });
        orders = await connector.fetchOrders(config.sinceId);
        break;
      }
      case 'ETSY': {
        const connector = new EtsyConnector({
          channelName: 'ETSY',
          accessToken: config.accessToken,
          sellerId: config.sellerId,
        });
        orders = await connector.fetchOrders();
        break;
      }
    }

    const result = await marketplaceService.importOrders(user.companyId, user.userId, orders);
    return { success: true, data: result };
  });

  // ═══════════════════════════════════════════════════════════════
  // CSV IMPORT
  // ═══════════════════════════════════════════════════════════════

  const csvImportSchema = z.object({
    csvText: z.string().min(1),
  });

  app.post('/import/csv-orders', async (request, reply) => {
    const user = getAuthUser(request);
    const { csvText } = csvImportSchema.parse(request.body);
    const result = await csvImportService.importFromCSV(user.companyId, user.userId, csvText);
    return { success: true, data: result };
  });

  // ═══════════════════════════════════════════════════════════════
  // BULK OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  const bulkStatusSchema = z.object({
    orderIds: z.array(z.string().uuid()).min(1),
    status: z.string(),
  });

  app.post('/orders/bulk/status', async (request) => {
    const user = getAuthUser(request);
    const { orderIds, status } = bulkStatusSchema.parse(request.body);
    const result = await bulkOpsService.bulkStatusChange(user.companyId, orderIds, status);
    return { success: true, data: result };
  });

  const bulkShipSchema = z.object({
    orders: z.array(z.object({
      orderId: z.string().uuid(),
      trackingNumber: z.string().optional(),
      trackingLink: z.string().optional(),
      courierName: z.string().optional(),
    })).min(1),
  });

  app.post('/orders/bulk/ship', async (request) => {
    const user = getAuthUser(request);
    const { orders } = bulkShipSchema.parse(request.body);
    const result = await bulkOpsService.bulkShip(user.companyId, orders);
    return { success: true, data: result };
  });

  const bulkInvoiceSchema = z.object({
    orderIds: z.array(z.string().uuid()).min(1),
    dateOfInvoice: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  });

  app.post('/orders/bulk/invoice', async (request) => {
    const user = getAuthUser(request);
    const { orderIds, dateOfInvoice } = bulkInvoiceSchema.parse(request.body);
    const result = await bulkOpsService.bulkInvoice(user.companyId, user.userId, orderIds, dateOfInvoice);
    return { success: true, data: result };
  });

  const bulkAllocateSchema = z.object({
    orderIds: z.array(z.string().uuid()).min(1),
    warehouseId: z.string().uuid(),
  });

  app.post('/orders/bulk/allocate', async (request) => {
    const user = getAuthUser(request);
    const { orderIds, warehouseId } = bulkAllocateSchema.parse(request.body);
    const result = await bulkOpsService.bulkAllocate(user.companyId, orderIds, warehouseId);
    return { success: true, data: result };
  });

  // ═══════════════════════════════════════════════════════════════
  // YEAR-END CLOSE (delegates to Luca)
  // ═══════════════════════════════════════════════════════════════

  const yearEndSchema = z.object({
    financialYearEnd: z.string().regex(/^\d{4}-\d{2}$/),
    newYearFirstPeriod: z.string().regex(/^\d{4}-\d{2}$/),
  });

  app.post('/year-end-close', async (request) => {
    const input = yearEndSchema.parse(request.body);
    const result = await yearEndService.performYearEndClose(input.financialYearEnd, input.newYearFirstPeriod);
    return { success: true, data: result };
  });

  app.get('/period-status/:periodId', async (request) => {
    const { periodId } = request.params as { periodId: string };
    const result = await yearEndService.checkPeriodStatus(periodId);
    return { success: true, data: result };
  });
}
