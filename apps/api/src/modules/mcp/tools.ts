/**
 * MCP read tools (P14, spec §A9). Each tool wraps the SAME service/query
 * functions the REST routes call, so the MCP and HTTP surfaces stay in lockstep.
 * Tools whose underlying data lands in later prompts (consumption / wastage /
 * sessions — P16-P18) return `{ available: false }` until then.
 */
import { and, eq, ilike, or } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, sites } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { StockQueryService } from '../stock/stock-query.service.js';
import { ReorderService } from '../reorder/reorder.service.js';
import { SessionConsumptionService } from '../consumption/session-consumption.service.js';
import { BumbleBeeSessionClient } from '../consumption/bumblebee-sessions.js';

export interface McpToolContext {
  companyId: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a `site` argument (a site id, slug, or canonical name) to a site id. */
async function resolveSiteId(site: unknown, companyId: string): Promise<string | undefined> {
  if (typeof site !== 'string' || !site) return undefined;
  if (UUID_RE.test(site)) return site;
  const row = await getDb().query.sites.findFirst({
    where: and(
      eq(sites.companyId, companyId),
      or(eq(sites.slug, site), eq(sites.canonicalName, site), eq(sites.name, site)),
    ),
  });
  return row?.id;
}

const obj = (props: Record<string, unknown>) => ({ type: 'object', properties: props });
const str = (description: string) => ({ type: 'string', description });

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'stock_on_hand',
    description: 'On-hand stock per (product, site). Optional site (id/slug/name) and item-kind filter.',
    inputSchema: obj({ site: str('Site id, slug or name'), item: str('item_kind filter') }),
    handler: async (args, ctx) => {
      const query = new StockQueryService();
      return query.listLevels({
        siteId: await resolveSiteId(args.site, ctx.companyId),
        itemKind: typeof args.item === 'string' ? args.item : undefined,
        companyId: ctx.companyId,
      });
    },
  },
  {
    name: 'low_stock',
    description: 'Items at/below their reorder point plus any open reorder proposals (reorder_suggestions).',
    inputSchema: obj({ site: str('Site id, slug or name') }),
    handler: async (args, ctx) => {
      const siteId = await resolveSiteId(args.site, ctx.companyId);
      const lowStock = await new StockQueryService().lowStock({ siteId, companyId: ctx.companyId });
      const proposals = await new ReorderService().list({ status: 'PROPOSED', siteId, companyId: ctx.companyId });
      return { lowStock, proposals };
    },
  },
  {
    name: 'reorder_suggestions',
    description: 'Open reorder proposals (replenishments to approve/place).',
    inputSchema: obj({ site: str('Site id, slug or name') }),
    handler: async (args, ctx) =>
      new ReorderService().list({
        status: 'PROPOSED',
        siteId: await resolveSiteId(args.site, ctx.companyId),
        companyId: ctx.companyId,
      }),
  },
  {
    name: 'stock_valuation',
    description: 'Weighted-average-cost stock valuation per site and item kind.',
    inputSchema: obj({ site: str('Site id, slug or name') }),
    handler: async (args, ctx) =>
      new StockQueryService().valuation({
        siteId: await resolveSiteId(args.site, ctx.companyId),
        companyId: ctx.companyId,
      }),
  },
  {
    name: 'consumption_variance',
    description: 'Expected vs actual vs counted consumption variance for a site + period.',
    inputSchema: obj({ site: str('Site'), period: str('Period, e.g. 2026-06') }),
    handler: async () => ({ available: false, note: 'Available once the head-baker consumption + reporting land (P16-P18).' }),
  },
  {
    name: 'wastage_report',
    description: 'Wastage by product for a site + period.',
    inputSchema: obj({ site: str('Site'), period: str('Period') }),
    handler: async () => ({ available: false, note: 'Available once wastage capture + reporting land (P16-P18).' }),
  },
  {
    name: 'sessions_awaiting_consumption',
    description: "Sessions at a site (for a date) still missing a head-baker consumption record.",
    inputSchema: obj({ site: str('Site id, slug or name'), date: str('Day, YYYY-MM-DD') }),
    handler: async (args, ctx) => {
      const siteId = await resolveSiteId(args.site, ctx.companyId);
      if (!siteId) return { awaiting: [], note: 'Unknown or unspecified site.' };
      const site = await getDb().query.sites.findFirst({
        where: and(eq(sites.id, siteId), eq(sites.companyId, ctx.companyId)),
      });
      const date = typeof args.date === 'string' ? args.date : undefined;
      let day: Awaited<ReturnType<BumbleBeeSessionClient['listSessionsForDay']>> = [];
      if (site && date) {
        day = await new BumbleBeeSessionClient().listSessionsForDay({
          siteCanonicalName: site.canonicalName,
          date,
          companyId: ctx.companyId,
        });
      }
      const awaiting = await new SessionConsumptionService().filterAwaiting(siteId, day, ctx.companyId);
      return { awaiting, polled: day.length };
    },
  },
  {
    name: 'purchase_order_status',
    description: 'Status of reorder/replenishment orders (proposed / approved / placed / emailed).',
    inputSchema: obj({ status: str('Filter by status') }),
    handler: async (args, ctx) =>
      new ReorderService().list({
        status: typeof args.status === 'string' ? args.status : undefined,
        companyId: ctx.companyId,
      }),
  },
  {
    name: 'product_lookup',
    description: 'Look up a product by barcode/ean or name.',
    inputSchema: obj({ barcode: str('Barcode or EAN'), name: str('Name (partial)') }),
    handler: async (args, ctx) => {
      const db = getDb();
      if (typeof args.barcode === 'string' && args.barcode) {
        return db.query.products.findMany({
          where: and(
            eq(products.companyId, ctx.companyId),
            or(eq(products.barcode, args.barcode), eq(products.ean, args.barcode)),
          ),
          limit: 20,
        });
      }
      if (typeof args.name === 'string' && args.name) {
        return db.query.products.findMany({
          where: and(eq(products.companyId, ctx.companyId), ilike(products.name, `%${args.name}%`)),
          limit: 20,
        });
      }
      return [];
    },
  },
];

export function getMcpTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

export const DEFAULT_MCP_COMPANY = getSingletonCompanyId;
