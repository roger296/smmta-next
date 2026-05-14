/**
 * Conversational search service.
 *
 * Orchestrates a single user query through:
 *
 *   1. Hash + cache lookup (24h in-memory Map).
 *   2. Daily-budget check — if today's LLM spend exceeds the
 *      `LLM_SEARCH_BUDGET_GBP_PER_DAY` env knob, skip the LLM call
 *      and fall through to keyword search.
 *   3. Parser call (Anthropic Haiku via the wrapper). Output is
 *      validated against `ParsedQuery` Zod schema; failures are
 *      treated as confidence: 'low' and we fall through to keyword
 *      search.
 *   4. Structured query: hand the parsed filters to the existing
 *      `CategoryService.listCategoryProducts` (or a keyword search
 *      across all categories when no `categorySlug` was returned).
 *   5. Log the result + cost + latency to `llm_search_log`.
 *
 * No PII goes to Anthropic. We send the customer's query text and
 * nothing else — no IP, no session, no email. The log table mirrors
 * that constraint: no customer identifier columns.
 *
 * Cache is single-process in-memory. Acceptable for a single-instance
 * deploy; a multi-instance deploy would either replace this Map with
 * Redis or accept the cost of duplicate parses across instances.
 * Spec'd in CLAUDE.md.
 */
import { createHash } from 'node:crypto';
import { and, eq, gte, ilike, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import {
  llmSearchLog,
  products,
  productGroups,
  productChannels,
} from '../../../db/schema/index.js';
import { chunkedQuery } from '../../../shared/db/chunk.js';
import {
  type AnthropicTransport,
  parseQuery,
} from './anthropic-client.js';
import {
  type ParsedQuery,
  type ParsedQueryConfidence,
} from './parser.types.js';
import { buildSystemPrompt } from './system-prompt.js';
import { getVariantAvailabilityBatch, type StockState } from '../availability.js';
import { CategoryService } from '../category.service.js';

interface CacheEntry {
  parsed: ParsedQuery;
  expiresAt: number;
  /** Held so we can return the same cost figure (zero) for cache hits
   *  without re-computing. */
  costGbp: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface SearchRequest {
  query: string;
  companyId: string;
  channelId: string | null;
  /** Apply a customer-override on top of the parsed filters. The
   *  storefront sends these from the "tweak filters" panel. */
  override?: ParsedQuery['filters'];
}

export interface SearchResultProduct {
  id: string;
  slug: string | null;
  name: string;
  colour: string | null;
  colourHex: string | null;
  priceGbp: string | null;
  heroImageUrl: string | null;
  stockState: StockState;
}

export interface SearchResponse {
  interpretation: string;
  parsed: ParsedQuery | null;
  products: SearchResultProduct[];
  totalCount: number;
  confidence: ParsedQueryConfidence | null;
  /** True when the LLM was bypassed (cache hit, budget exceeded, no key). */
  llmBypassed: boolean;
  /** Wall-clock latency in ms — what we logged. */
  latencyMs: number;
}

export class SearchService {
  private cache = new Map<string, CacheEntry>();
  private categoryService = new CategoryService();

  constructor(
    private readonly opts: {
      anthropicApiKey: string | undefined;
      dailyBudgetGbp: number;
      transport?: AnthropicTransport;
    },
  ) {}

  // Exposed for tests so they can prime / inspect the cache.
  /** @internal */
  _cache(): Map<string, CacheEntry> {
    return this.cache;
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    const startedAt = Date.now();
    const trimmed = req.query.trim().slice(0, 240);
    if (!trimmed) {
      return {
        interpretation: '',
        parsed: null,
        products: [],
        totalCount: 0,
        confidence: null,
        llmBypassed: true,
        latencyMs: 0,
      };
    }

    const hash = hashQuery(trimmed);
    let parsed: ParsedQuery | null = null;
    let llmCost = 0;
    let cacheHit = false;
    let llmBypassed = false;

    // 1. Cache.
    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > Date.now()) {
      parsed = cached.parsed;
      cacheHit = true;
      llmCost = 0;
    } else {
      // 2. Budget check.
      const spent = await this.todaysSpendGbp(req.companyId);
      if (spent >= this.opts.dailyBudgetGbp) {
        llmBypassed = true;
      } else if (!this.opts.anthropicApiKey) {
        // Key not configured — fall back to keyword search without
        // attempting the LLM call. Useful in dev / for the read-only
        // deploy that doesn't pay for tokens.
        llmBypassed = true;
      } else {
        // 3. LLM call.
        try {
          const result = await parseQuery({
            apiKey: this.opts.anthropicApiKey,
            systemPrompt: buildSystemPrompt(),
            userQuery: trimmed,
            transport: this.opts.transport,
          });
          parsed = result.parsed;
          llmCost = result.costGbp;
          if (parsed) {
            this.cache.set(hash, {
              parsed,
              expiresAt: Date.now() + CACHE_TTL_MS,
              costGbp: llmCost,
            });
          }
        } catch (err) {
          // Network / API errors degrade to keyword fallback rather
          // than 500-ing the user-facing endpoint.
          // eslint-disable-next-line no-console
          console.error('[search] parseQuery failed:', err);
          parsed = null;
        }
      }
    }

    // 4. DB query.
    const effectiveFilters = mergeFilters(parsed?.filters, req.override);
    const dbResults =
      parsed && parsed.confidence !== 'low' && parsed.categorySlug
        ? await this.queryByCategory(req.companyId, req.channelId, parsed, effectiveFilters)
        : await this.queryByKeywords(
            req.companyId,
            req.channelId,
            parsed?.keywords ?? trimmed.split(/\s+/),
            effectiveFilters,
          );

    const latencyMs = Date.now() - startedAt;

    // 5. Log (fire-and-forget — don't block the customer's response).
    void this.logQuery({
      companyId: req.companyId,
      query: trimmed,
      queryHash: hash,
      parsed,
      resultCount: dbResults.products.length,
      latencyMs,
      cacheHit,
      costGbp: llmCost,
    });

    const fallbackInterpretation = parsed?.interpretation
      ?? (llmBypassed
        ? `Showing keyword matches for "${trimmed}".`
        : `Showing best matches for "${trimmed}".`);

    return {
      interpretation: fallbackInterpretation,
      parsed,
      products: dbResults.products,
      totalCount: dbResults.totalCount,
      confidence: parsed?.confidence ?? null,
      llmBypassed,
      latencyMs,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Structured query — re-use CategoryService for category + filters
  // ──────────────────────────────────────────────────────────

  private async queryByCategory(
    companyId: string,
    channelId: string | null,
    parsed: ParsedQuery,
    filters: ParsedQuery['filters'],
  ): Promise<{ products: SearchResultProduct[]; totalCount: number }> {
    if (!parsed.categorySlug) {
      return { products: [], totalCount: 0 };
    }
    const result = await this.categoryService.listCategoryProducts(
      companyId,
      parsed.categorySlug,
      channelId,
      {
        filters: {
          stockState: filters.stockState ?? ['IN_STOCK', 'AVAILABLE_FROM_SUPPLIER'],
          colour: filters.colour,
          size: filters.size,
          brand: filters.brand,
          priceMin: filters.priceMin,
          priceMax: filters.priceMax,
        },
        sort:
          parsed.sort === 'price-asc' || parsed.sort === 'price-desc' || parsed.sort === 'newest'
            ? parsed.sort
            : 'newest',
        page: 1,
      },
    );
    if (!result) return { products: [], totalCount: 0 };
    return {
      products: result.products.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        colour: p.colour,
        colourHex: p.colourHex,
        priceGbp: p.priceGbp,
        heroImageUrl: p.heroImageUrl,
        stockState: p.stockState,
      })),
      totalCount: result.totalCount,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Keyword fallback — ILIKE against name + group_type
  // ──────────────────────────────────────────────────────────

  private async queryByKeywords(
    companyId: string,
    channelId: string | null,
    keywords: string[],
    filters: ParsedQuery['filters'],
  ): Promise<{ products: SearchResultProduct[]; totalCount: number }> {
    const db = getDb();
    const tokens = keywords.flatMap((k) => k.split(/\s+/)).filter((t) => t.length >= 2);
    if (tokens.length === 0) return { products: [], totalCount: 0 };

    // Match products where the name OR group name contains any token.
    // ILIKE for case-insensitive — keep it simple, no full-text index
    // yet. At 100k rows it's a sequential scan; if this becomes a
    // perf problem, add a trigram or tsvector index.
    const nameConditions = tokens.map((t) =>
      or(ilike(products.name, `%${t}%`), ilike(productGroups.name, `%${t}%`)),
    );
    const rows = await db
      .select({
        id: products.id,
        slug: products.slug,
        name: products.name,
        colour: products.colour,
        colourHex: products.colourHex,
        priceGbp: products.minSellingPrice,
        heroImageUrl: products.heroImageUrl,
      })
      .from(products)
      .leftJoin(productGroups, eq(productGroups.id, products.groupId))
      .where(
        and(
          eq(products.companyId, companyId),
          eq(products.isPublished, true),
          isNull(products.deletedAt),
          // OR across all token conditions ⇒ products matching at least one keyword.
          or(...nameConditions),
        ),
      )
      .limit(200); // Cap; the storefront page paginates client-side for V1.

    if (rows.length === 0) return { products: [], totalCount: 0 };

    // Channel scoping + stock state filter.
    const productIds = rows.map((r) => r.id);
    const availability = await getVariantAvailabilityBatch(companyId, productIds);
    let channelMap: Map<string, boolean> | null = null;
    if (channelId) {
      const pcRows = await chunkedQuery(productIds, (chunk) =>
        db
          .select({
            productId: productChannels.productId,
            channelId: productChannels.channelId,
            isOffered: productChannels.isOffered,
          })
          .from(productChannels)
          .where(and(isNull(productChannels.deletedAt))),
      );
      const byProduct = new Map<string, typeof pcRows>();
      for (const r of pcRows) {
        const arr = byProduct.get(r.productId);
        if (arr) arr.push(r);
        else byProduct.set(r.productId, [r]);
      }
      channelMap = new Map();
      for (const [pid, list] of byProduct) {
        const here = list.find((r) => r.channelId === channelId);
        channelMap.set(pid, here ? here.isOffered : false);
      }
    }

    const allowedStock = new Set<StockState>(
      filters.stockState ?? ['IN_STOCK', 'AVAILABLE_FROM_SUPPLIER'],
    );

    const filtered: SearchResultProduct[] = [];
    for (const r of rows) {
      const offered = channelMap ? (channelMap.get(r.id) ?? true) : true;
      if (!offered) continue;
      const a = availability.get(r.id);
      const stockState: StockState = a?.stockState ?? 'OUT_OF_STOCK';
      if (!allowedStock.has(stockState)) continue;
      if (filters.colour && r.colour && !filters.colour.includes(r.colour)) continue;
      filtered.push({
        id: r.id,
        slug: r.slug,
        name: r.name,
        colour: r.colour,
        colourHex: r.colourHex,
        priceGbp: r.priceGbp,
        heroImageUrl: r.heroImageUrl,
        stockState,
      });
    }
    return { products: filtered.slice(0, 60), totalCount: filtered.length };
  }

  // ──────────────────────────────────────────────────────────
  // Budget tracking
  // ──────────────────────────────────────────────────────────

  /** Sum of today's `cost_gbp` for this company. Cheap query: one
   *  aggregate over the small `llm_search_log` table. */
  private async todaysSpendGbp(companyId: string): Promise<number> {
    const db = getDb();
    // Start of today, UTC. Per-row createdAt is timestamptz so direct
    // comparison works.
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const rows = await db
      .select({
        total: sql<string>`COALESCE(SUM(${llmSearchLog.costGbp}), 0)::text`,
      })
      .from(llmSearchLog)
      .where(
        and(
          eq(llmSearchLog.companyId, companyId),
          gte(llmSearchLog.createdAt, start),
        ),
      );
    const n = Number.parseFloat(rows[0]?.total ?? '0');
    return Number.isFinite(n) ? n : 0;
  }

  // ──────────────────────────────────────────────────────────
  // Logging
  // ──────────────────────────────────────────────────────────

  private async logQuery(args: {
    companyId: string;
    query: string;
    queryHash: string;
    parsed: ParsedQuery | null;
    resultCount: number;
    latencyMs: number;
    cacheHit: boolean;
    costGbp: number;
  }): Promise<void> {
    try {
      const db = getDb();
      await db.insert(llmSearchLog).values({
        companyId: args.companyId,
        query: args.query,
        queryHash: args.queryHash,
        parsedOutput: args.parsed ?? null,
        confidence: args.parsed?.confidence ?? null,
        resultCount: args.resultCount,
        latencyMs: args.latencyMs,
        cacheHit: args.cacheHit,
        costGbp: args.costGbp.toFixed(6),
      });
    } catch (err) {
      // Logging failures must NEVER break the search response.
      // eslint-disable-next-line no-console
      console.error('[search] logQuery failed:', err);
    }
  }
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

export function hashQuery(q: string): string {
  return createHash('sha256').update(q.toLowerCase().trim()).digest('hex');
}

/** Merge customer override filters on top of parsed filters. Override
 *  wins per-axis: if the customer set a colour explicitly, ignore
 *  whatever colour the parser guessed. */
export function mergeFilters(
  parsed: ParsedQuery['filters'] | undefined,
  override: ParsedQuery['filters'] | undefined,
): ParsedQuery['filters'] {
  const out: ParsedQuery['filters'] = { ...(parsed ?? {}) };
  if (!override) return out;
  if (override.gender) out.gender = override.gender;
  if (override.brand) out.brand = override.brand;
  if (override.sustainability) out.sustainability = override.sustainability;
  if (override.colour) out.colour = override.colour;
  if (override.size) out.size = override.size;
  if (override.priceMin !== undefined) out.priceMin = override.priceMin;
  if (override.priceMax !== undefined) out.priceMax = override.priceMax;
  if (override.stockState) out.stockState = override.stockState;
  return out;
}
