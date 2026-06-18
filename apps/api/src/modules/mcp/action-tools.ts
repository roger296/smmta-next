/**
 * Guarded MCP action tools (P19, spec §A9, Phase 2).
 *
 * Write actions Claude / Cowork can take, each wrapping an existing service so
 * the mutation lands in the same audit / idempotency tables as the REST + UI
 * paths (`stock_movements`, `reorder_proposals`, `stock_takes`, `gl_posting_log`).
 *
 * Two guards:
 *   1. **Scope** — only a key with `mcp:write` may call these (enforced in the
 *      dispatch); a read-only (`mcp:read`) key is rejected.
 *   2. **Confirm** — nothing mutates unless `confirm: true` is passed; otherwise
 *      the tool returns a no-mutation *preview* of what it would do.
 * Every call is also written to `mcp_audit_log` by the dispatch.
 */
import { StockLevelService } from '../stock/stock-level.service.js';
import { StockTakeService } from '../stock-take/stock-take.service.js';
import { ReorderService } from '../reorder/reorder.service.js';
import { resolveSiteId, type McpToolContext } from './tools.js';

export interface McpActionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** A no-mutation description of what `confirm` would do. */
  preview: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown> | unknown;
  /** Perform the mutation — only called when confirm === true. */
  execute: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const confirm = {
  confirm: { type: 'boolean', description: 'Set true to perform the action. Omit/false returns a preview and changes nothing.' },
};
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties: { ...props, ...confirm },
  required,
});

const asNum = (v: unknown): number => (v == null ? 0 : Number(v));
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export const MCP_ACTION_TOOLS: McpActionTool[] = [
  {
    name: 'adjust_stock',
    description: 'Adjust on-hand stock for a (product, site) by a signed quantity (an ADJUSTMENT movement). Pass a stable idempotencyKey to make replays safe.',
    inputSchema: obj(
      {
        productId: str('Product id'),
        site: str('Site id, slug or name'),
        qtyDelta: num('Signed quantity in stock units (negative to reduce)'),
        idempotencyKey: str('Stable key — a replay with the same key is a no-op'),
      },
      ['productId', 'site', 'qtyDelta'],
    ),
    preview: async (args, ctx) => {
      const siteId = await resolveSiteId(args.site, ctx.companyId);
      const onHand = siteId
        ? await new StockLevelService().getOnHand(asStr(args.productId)!, siteId, ctx.companyId)
        : '0';
      return {
        action: 'adjust_stock',
        summary: `Adjust product ${asStr(args.productId)} at site ${args.site} by ${asNum(args.qtyDelta)} (current on-hand ${onHand}).`,
        productId: args.productId,
        siteId,
        qtyDelta: asNum(args.qtyDelta),
      };
    },
    execute: async (args, ctx) => {
      const siteId = await resolveSiteId(args.site, ctx.companyId);
      if (!siteId) throw new Error('Unknown site');
      return new StockLevelService().adjust({
        productId: asStr(args.productId)!,
        siteId,
        qtyDelta: asNum(args.qtyDelta),
        idempotencyKey: asStr(args.idempotencyKey),
        companyId: ctx.companyId,
      });
    },
  },
  {
    name: 'set_reorder_level',
    description: 'Set the reorder point / up-to / min-days-cover for a (product, site).',
    inputSchema: obj(
      {
        productId: str('Product id'),
        site: str('Site id, slug or name'),
        reorderPoint: num('Reorder point (stock units)'),
        reorderUpTo: num('Order up to (stock units)'),
        minDaysCover: num('Minimum days of cover'),
      },
      ['productId', 'site'],
    ),
    preview: async (args, ctx) => ({
      action: 'set_reorder_level',
      summary: `Set reorder levels for product ${asStr(args.productId)} at site ${args.site}.`,
      productId: args.productId,
      siteId: await resolveSiteId(args.site, ctx.companyId),
      reorderPoint: args.reorderPoint ?? null,
      reorderUpTo: args.reorderUpTo ?? null,
      minDaysCover: args.minDaysCover ?? null,
    }),
    execute: async (args, ctx) => {
      const siteId = await resolveSiteId(args.site, ctx.companyId);
      if (!siteId) throw new Error('Unknown site');
      await new StockLevelService().setReorderParams({
        productId: asStr(args.productId)!,
        siteId,
        reorderPoint: args.reorderPoint == null ? undefined : asNum(args.reorderPoint),
        reorderUpTo: args.reorderUpTo == null ? undefined : asNum(args.reorderUpTo),
        minDaysCover: args.minDaysCover == null ? undefined : asNum(args.minDaysCover),
        companyId: ctx.companyId,
      });
      return { ok: true, productId: args.productId, siteId };
    },
  },
  {
    name: 'start_stock_take',
    description: 'Open a stock-take at a site (snapshots book stock for the scope).',
    inputSchema: obj(
      {
        site: str('Site id, slug or name'),
        scope: str('FULL | CATEGORY | ZONE | ITEM | CYCLE (default FULL)'),
        scopeRef: str('Category/product id for a scoped take'),
      },
      ['site'],
    ),
    preview: async (args, ctx) => ({
      action: 'start_stock_take',
      summary: `Open a ${asStr(args.scope) ?? 'FULL'} stock-take at site ${args.site}.`,
      siteId: await resolveSiteId(args.site, ctx.companyId),
      scope: asStr(args.scope) ?? 'FULL',
    }),
    execute: async (args, ctx) => {
      const siteId = await resolveSiteId(args.site, ctx.companyId);
      if (!siteId) throw new Error('Unknown site');
      const { take, lines } = await new StockTakeService().open({
        siteId,
        scope: (asStr(args.scope) as 'FULL') ?? 'FULL',
        scopeRef: asStr(args.scopeRef) ?? null,
        companyId: ctx.companyId,
      });
      return { takeId: take.id, scope: take.scope, lineCount: lines.length };
    },
  },
  {
    name: 'approve_reorder',
    description: 'Approve an open reorder proposal (clears it to be placed).',
    inputSchema: obj({ proposalId: str('Reorder proposal id') }, ['proposalId']),
    preview: (args) => ({
      action: 'approve_reorder',
      summary: `Approve reorder proposal ${asStr(args.proposalId)}.`,
      proposalId: args.proposalId,
    }),
    execute: async (args, ctx) => {
      const row = await new ReorderService().approve(asStr(args.proposalId)!, ctx.companyId);
      return row ?? { ok: false, note: 'No open proposal with that id' };
    },
  },
  {
    name: 'create_purchase_order',
    description: 'Place an approved reorder proposal as a purchase order (renders the emailed PO or records a connector placement).',
    inputSchema: obj({ proposalId: str('Reorder proposal id') }, ['proposalId']),
    preview: (args) => ({
      action: 'create_purchase_order',
      summary: `Place proposal ${asStr(args.proposalId)} as a purchase order.`,
      proposalId: args.proposalId,
    }),
    execute: async (args, ctx) => {
      const row = await new ReorderService().place(asStr(args.proposalId)!, ctx.companyId);
      return row ?? { ok: false, note: 'No proposal with that id' };
    },
  },
];

export function getMcpActionTool(name: string): McpActionTool | undefined {
  return MCP_ACTION_TOOLS.find((t) => t.name === name);
}
