import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(250).default(50),
  sortBy: z.string().optional(),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export function paginationMeta(total: number, page: number, pageSize: number) {
  return {
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export function paginationOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

/**
 * A free-text search term from a query string.
 *
 * Trims, and treats a term that was only whitespace as absent. A padded term
 * is otherwise fatal rather than merely untidy: every search here becomes
 * ILIKE '%<term>%', so a trailing space from a paste or a phone keyboard
 * matches nothing and reads as "no results" rather than as a typo.
 *
 * Applied at the schema so it holds for every client, not only the admin SPA
 * — which trims before sending, but is not the only thing that can call this.
 */
export const searchTermSchema = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : undefined;
  });
