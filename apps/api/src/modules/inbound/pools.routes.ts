/**
 * Storefront-facing stock + pre-order pools for one SKU (SPEC F1, §14.3). Gated
 * by the storefront api-key. Returns the warehouse band plus every unarrived
 * inbound pool with its exact presale availability and the CUSTOMER-FACING
 * pre-order price (£ savings only — no percentages, no internal fields). This is
 * what the PDP renders.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyAuth } from '../../shared/middleware/api-key.js';
import { InboundService } from './inbound.service.js';
import { PricingService, PricingError } from '../pricing/pricing.service.js';

const inbound = new InboundService();
const pricing = new PricingService();

export async function poolsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', apiKeyAuth(['storefront:read']));

  app.get('/storefront/skus/:sku/pools', async (request, reply) => {
    const { sku } = z.object({ sku: z.string().min(1) }).parse(request.params);
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
