import { z } from 'zod';

/**
 * The hard cap on `pageSize` for every paginated endpoint.
 *
 * Exported because a client that asks for more gets a **400**, not a truncated
 * page — and on 12 Aug that was invisible: the stock-take screen requested
 * `pageSize=500`, the request 400d, the product-name lookup errored, and every
 * row on the count sheet rendered as a hex fragment (defect D-1). The web app
 * mirrors this constant in `apps/web/src/lib/api-client.ts` and a unit test
 * fails if any request in `apps/web/src` exceeds it.
 */
export const MAX_PAGE_SIZE = 250;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE, { message: `pageSize must not exceed ${MAX_PAGE_SIZE}` })
    .default(50),
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
