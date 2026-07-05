/**
 * Storefront-facing stock + pre-order pools for one SKU (SPEC F1, §14.3). Gated
 * by the storefront api-key. Returns the warehouse band plus every unarrived
 * inbound pool with its exact presale availability and the CUSTOMER-FACING
 * pre-order price (£ savings only — no percentages, no internal fields). This is
 * what the PDP renders.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { apiKeyAuth } from '../../shared/middleware/api-key.js';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { products } from '../../db/schema/index.js';
import { InboundService } from './inbound.service.js';
import { PricingService, PricingError } from '../pricing/pricing.service.js';

const inbound = new InboundService();
const pricing = new PricingService();

/** Resolve a path param that may be a stock code OR a product slug → stock code. */
async function resolveSku(param: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ stockCode: products.stockCode })
    .from(products)
    .where(and(eq(products.companyId, getSingletonCompanyId()), or(eq(products.stockCode, param), eq(products.slug, param))))
    .limit(1);
  return row?.stockCode ?? null;
}

export async function poolsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:read']));

  app.get('/storefront/skus/:sku/pools', async (request, reply) => {
    const { sku: param } = z.object({ sku: z.string().min(1) }).parse(request.params);
    const sku = (await resolveSku(param)) ?? param;
    const stock = await inbound.getStockAndEta(sku);

    // Warehouse base price (customer-facing) for reference, if the SKU is priced.
    let warehousePricePence: number | null = null;
    try {
      const q = await pricing.quoteCustomerFacing({ sku, qty: 1, pool: 'warehouse' });
      warehousePricePence = q.unitPricePence;
    } catch (err) {
      if (!(err instanceof PricingError)) throw err;
    }

    const inboundPools = await Promise.all(
      stock.inbound.map(async (pool) => {
        try {
          const q = await pricing.quoteCustomerFacing({ sku, qty: 1, pool: pool.shipmentRef });
          return {
            shipmentRef: pool.shipmentRef,
            mode: pool.mode,
            eta: pool.eta.toISOString(),
            presaleAvailable: pool.presaleAvailable,
            unitPricePence: q.unitPricePence,
            savingsVsBasePence: q.savingsVsBasePence,
          };
        } catch {
          return null;
        }
      }),
    );

    return reply.send({
      success: true,
      data: {
        sku,
        warehouse: { band: stock.warehouse.band, availableQty: stock.warehouse.availableQty, pricePence: warehousePricePence },
        inbound: inboundPools.filter(Boolean),
      },
    });
  });
}
