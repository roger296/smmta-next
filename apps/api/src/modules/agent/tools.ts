/**
 * Sales-agent tool layer (SPEC §14). Two things live here:
 *  - TOOL_SCHEMAS: the OpenRouter-facing function-calling contract. CRITICAL:
 *    no tool accepts user_id / session_id / basket_id — identity is
 *    server-injected from the session, so cross-customer access is structurally
 *    impossible regardless of prompt injection (§14.1).
 *  - executeTool: direct service-layer calls (NOT HTTP to self), returning the
 *    uniform { ok, data } | { ok:false, error:{ code, message } } envelope with
 *    the §14.2 error codes. quote_price returns the CUSTOMER-FACING serializer
 *    only.
 */
import { and, eq, ilike } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { products, escalations } from '../../db/schema/index.js';
import type { LlmToolDef } from '../../integrations/openrouter/index.js';
import { InboundService } from '../inbound/inbound.service.js';
import { PricingService, PricingError } from '../pricing/pricing.service.js';
import { InterestFlagService } from '../interest/interest.service.js';
import { BasketService, InsufficientStockError } from './basket.service.js';

export type ToolErrorCode =
  | 'INVALID_SKU'
  | 'INSUFFICIENT_STOCK'
  | 'POOL_UNAVAILABLE'
  | 'LINE_NOT_FOUND'
  | 'LOGIN_REQUIRED'
  | 'CONSENT_REQUIRED'
  | 'INVALID_CODE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export type ToolEnvelope =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: ToolErrorCode; message: string } };

export interface ToolContext {
  /** null for anonymous browsing. NEVER supplied by the model. */
  userId: string | null;
  /** The live basket, injected from the session. NEVER supplied by the model. */
  basketId: string;
  chatSessionId: string;
  nowMs?: number;
}

const ok = (data: unknown): ToolEnvelope => ({ ok: true, data });
const err = (code: ToolErrorCode, message: string): ToolEnvelope => ({ ok: false, error: { code, message } });

// ---- Tool schemas (§14.3). Identity/basket are ABSENT by design. ----
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});

export const TOOL_SCHEMAS: LlmToolDef[] = [
  {
    name: 'search_catalogue',
    description:
      "Search ranged products. Returns matches with sku, name, colour, display_price (INDICATIVE ONLY — call quote_price before stating any price), and stock_band.",
    parameters: obj(
      {
        query: { type: 'string' },
        material: { type: 'string' },
        colour: { type: 'string' },
        limit: { type: 'integer', default: 8, maximum: 20 },
      },
      ['query'],
    ),
  },
  {
    name: 'get_product_details',
    description: 'Full detail for one SKU: description, carton size, base price.',
    parameters: obj({ sku: { type: 'string' } }, ['sku']),
  },
  {
    name: 'get_stock_and_eta',
    description:
      'Availability for a SKU across stock pools: warehouse band + inbound pools with exact presale availability and pre-order saving.',
    parameters: obj({ sku: { type: 'string' } }, ['sku']),
  },
  {
    name: 'quote_price',
    description:
      'THE ONLY SOURCE OF TRUTH FOR PRICES. Quotes sku+qty+pool. Sell using the £ savings figures only (§15.1a) — never percentages.',
    parameters: obj(
      { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 }, pool: { type: 'string', default: 'warehouse' } },
      ['sku', 'qty'],
    ),
  },
  {
    name: 'view_basket',
    description: 'Current basket: lines, totals, applied code. Call when unsure rather than relying on memory.',
    parameters: obj({}),
  },
  {
    name: 'add_to_basket',
    description:
      'Add sku+qty from a pool. Server re-prices authoritatively and returns the COMPLETE new basket. On INSUFFICIENT_STOCK for warehouse, check inbound pools before giving up.',
    parameters: obj(
      { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 }, pool: { type: 'string', default: 'warehouse' } },
      ['sku', 'qty'],
    ),
  },
  {
    name: 'update_basket_line',
    description: 'Change quantity on an existing line (from view_basket line_id). Returns the complete new basket.',
    parameters: obj({ line_id: { type: 'string' }, qty: { type: 'integer', minimum: 1 } }, ['line_id', 'qty']),
  },
  {
    name: 'remove_basket_line',
    description: 'Remove a line. Returns the complete new basket.',
    parameters: obj({ line_id: { type: 'string' } }, ['line_id']),
  },
  {
    name: 'check_discount_code',
    description:
      'Validate a customer-supplied discount code and, if valid, apply it to the basket (best-of vs the structural stack). You cannot invent codes.',
    parameters: obj({ code: { type: 'string' } }, ['code']),
  },
  {
    name: 'get_customer_interests',
    description: 'Logged-in customers only (else LOGIN_REQUIRED). Returns active watches enriched with ETA + pre-order saving.',
    parameters: obj({}),
  },
  {
    name: 'create_interest_flag',
    description:
      'Register a watch AFTER the customer agrees. flag_type: restock / offers / register_interest. Anonymous users need the email form (LOGIN_REQUIRED here).',
    parameters: obj(
      {
        sku: { type: 'string' },
        prospective_id: { type: 'string' },
        flag_type: { type: 'string', enum: ['restock', 'offers', 'register_interest'] },
      },
      ['flag_type'],
    ),
  },
  {
    name: 'escalate_to_human',
    description: 'Hand off to the owner for anything outside sales scope (delivery issues, refunds, trade accounts, complex advice).',
    parameters: obj(
      {
        reason: {
          type: 'string',
          enum: ['delivery_issue', 'refund_dispute', 'trade_account', 'product_advice_complex', 'other'],
        },
        summary: { type: 'string' },
      },
      ['reason', 'summary'],
    ),
  },
];

export const TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.name);

export class ToolExecutor {
  private db = getDb();
  private companyId = getSingletonCompanyId();
  private inbound = new InboundService();
  private pricing = new PricingService();
  private interest = new InterestFlagService();
  private basket = new BasketService();

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
    try {
      switch (name) {
        case 'search_catalogue':
          return await this.searchCatalogue(args);
        case 'get_product_details':
          return await this.getProductDetails(String(args.sku));
        case 'get_stock_and_eta':
          return ok(await this.inbound.getStockAndEta(String(args.sku)));
        case 'quote_price':
          return await this.quotePrice(args, ctx);
        case 'view_basket':
          return ok(await this.basket.view(ctx.basketId));
        case 'add_to_basket':
          return await this.addToBasket(args, ctx);
        case 'update_basket_line':
          return ok(await this.basket.updateLine(String(args.line_id), Number(args.qty)));
        case 'remove_basket_line':
          return ok(await this.basket.removeLine(String(args.line_id)));
        case 'check_discount_code':
          return await this.checkDiscountCode(String(args.code), ctx);
        case 'get_customer_interests':
          if (!ctx.userId) return err('LOGIN_REQUIRED', 'sign in to see your watches');
          return ok(await this.interest.listInterests(ctx.userId));
        case 'create_interest_flag':
          return await this.createInterestFlag(args, ctx);
        case 'escalate_to_human':
          return await this.escalate(args, ctx);
        default:
          return err('INTERNAL', `unknown tool ${name}`);
      }
    } catch (e) {
      if (e instanceof PricingError) return err(e.code, e.message);
      if (e instanceof InsufficientStockError) return err('INSUFFICIENT_STOCK', e.message);
      if (e instanceof Error && e.message === 'LINE_NOT_FOUND') return err('LINE_NOT_FOUND', 'line not found');
      return err('INTERNAL', 'tool failed');
    }
  }

  private async searchCatalogue(args: Record<string, unknown>): Promise<ToolEnvelope> {
    const query = String(args.query ?? '');
    const limit = Math.min(Number(args.limit ?? 8), 20);
    const rows = await this.db
      .select({ sku: products.stockCode, name: products.name, colour: products.colour, price: products.minSellingPrice })
      .from(products)
      .where(and(eq(products.companyId, this.companyId), ilike(products.name, `%${query}%`)))
      .limit(limit);
    const results = await Promise.all(
      rows
        .filter((r) => r.sku)
        .map(async (r) => {
          const stock = await this.inbound.getStockAndEta(r.sku!);
          return {
            sku: r.sku,
            name: r.name,
            colour: r.colour,
            display_price_pence: r.price ? Math.round(parseFloat(r.price) * 100) : null,
            stock_band: stock.warehouse.band,
          };
        }),
    );
    return ok({ results });
  }

  private async getProductDetails(sku: string): Promise<ToolEnvelope> {
    const [p] = await this.db
      .select({
        sku: products.stockCode,
        name: products.name,
        description: products.description,
        colour: products.colour,
        cartonSize: products.cartonSize,
        price: products.minSellingPrice,
      })
      .from(products)
      .where(and(eq(products.companyId, this.companyId), eq(products.stockCode, sku)))
      .limit(1);
    if (!p) return err('INVALID_SKU', `no product ${sku}`);
    return ok({ ...p, display_price_pence: p.price ? Math.round(parseFloat(p.price) * 100) : null });
  }

  private async quotePrice(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
    const quote = await this.pricing.quoteCustomerFacing({
      sku: String(args.sku),
      qty: Number(args.qty),
      pool: args.pool ? String(args.pool) : 'warehouse',
      nowMs: ctx.nowMs,
    });
    return ok(quote);
  }

  private async addToBasket(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
    const view = await this.basket.addLine(
      ctx.basketId,
      String(args.sku),
      Number(args.qty),
      args.pool ? String(args.pool) : 'warehouse',
    );
    return ok(view);
  }

  private async checkDiscountCode(code: string, ctx: ToolContext): Promise<ToolEnvelope> {
    const view = await this.basket.applyCode(ctx.basketId, code);
    return ok(view);
  }

  private async createInterestFlag(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
    if (!ctx.userId) return err('LOGIN_REQUIRED', 'the email form captures anonymous watches');
    const result = await this.interest.createInterestFlag({
      userId: ctx.userId,
      sku: args.sku ? String(args.sku) : undefined,
      prospectiveId: args.prospective_id ? String(args.prospective_id) : undefined,
      flagType: args.flag_type as 'restock' | 'offers' | 'register_interest',
      sourcePage: 'chat',
    });
    return ok(await this.interest.listInterests(result.userId));
  }

  private async escalate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolEnvelope> {
    const [row] = await this.db
      .insert(escalations)
      .values({
        companyId: this.companyId,
        chatSessionId: ctx.chatSessionId,
        reason: args.reason as 'delivery_issue' | 'refund_dispute' | 'trade_account' | 'product_advice_complex' | 'other',
        summary: String(args.summary ?? ''),
      })
      .returning({ id: escalations.id });
    return ok({ escalationId: row!.id, message: 'The owner will follow up.' });
  }
}
