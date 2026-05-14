/**
 * Shape of the LLM-parsed shopping query.
 *
 * The parser receives a natural-language query like
 *
 *   "navy fleece for outdoor work, large, ideally under £40"
 *
 * and returns a `ParsedQuery` that the search service can map onto
 * the existing category endpoint's filter shape.
 *
 * Wide-vs-strict tension: the parser is a foreign system (Claude). We
 * want the Zod schema to be permissive enough not to reject reasonable
 * outputs the model produces, but strict enough that nonsense gets
 * caught by our validator before we hand it to the DB layer.
 *
 * Confidence drives fallback: `confidence: 'low'` (or the parser
 * failing entirely) tells the search service to ignore the structured
 * filters and do a keyword search on the raw query instead.
 */
import { z } from 'zod';

export const PARSED_QUERY_STOCK_STATES = ['IN_STOCK', 'AVAILABLE_FROM_SUPPLIER'] as const;
export const PARSED_QUERY_SORTS = ['relevance', 'newest', 'price-asc', 'price-desc'] as const;
export const PARSED_QUERY_CONFIDENCE = ['high', 'medium', 'low'] as const;

export const parsedQueryFiltersSchema = z
  .object({
    gender: z.array(z.string().min(1).max(40)).max(8).optional(),
    brand: z.array(z.string().min(1).max(60)).max(20).optional(),
    sustainability: z.array(z.string().min(1).max(40)).max(8).optional(),
    colour: z.array(z.string().min(1).max(40)).max(20).optional(),
    size: z.array(z.string().min(1).max(20)).max(20).optional(),
    priceMin: z.number().nonnegative().finite().optional(),
    priceMax: z.number().nonnegative().finite().optional(),
    stockState: z.array(z.enum(PARSED_QUERY_STOCK_STATES)).max(2).optional(),
  })
  .strict();

export const parsedQuerySchema = z
  .object({
    /** One-sentence summary the customer can see ("Searching for navy
     *  fleeces under £40 in size L"). */
    interpretation: z.string().min(1).max(280),
    /** A taxonomy slug-path from `categories.taxonomy` (e.g.
     *  "outerwear/fleeces"). Optional — when missing, the search
     *  service falls back to keyword search across all categories. */
    categorySlug: z.string().min(1).max(100).optional(),
    /** Free-text words the parser couldn't fit into structured
     *  filters. Used for fallback keyword search if the structured
     *  query returns too few hits. */
    keywords: z.array(z.string().min(1).max(40)).max(20).default([]),
    filters: parsedQueryFiltersSchema.default({}),
    sort: z.enum(PARSED_QUERY_SORTS).optional(),
    confidence: z.enum(PARSED_QUERY_CONFIDENCE),
  })
  .strict();

export type ParsedQuery = z.infer<typeof parsedQuerySchema>;
export type ParsedQueryFilters = z.infer<typeof parsedQueryFiltersSchema>;
export type ParsedQueryConfidence = (typeof PARSED_QUERY_CONFIDENCE)[number];
