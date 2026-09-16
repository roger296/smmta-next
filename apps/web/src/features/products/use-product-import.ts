import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ImportRowError {
  row: number;
  stockCode: string | null;
  message: string;
}

export interface ProductImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  errors: ImportRowError[];
  ignoredColumns: string[];
  unknownColumns: string[];
  createdCategories: string[];
  createdSample: string[];
  updatedSample: string[];
}

export interface ProductImportRequest {
  csv: string;
  dryRun: boolean;
  createMissingCategories: boolean;
}

/**
 * Posts the chosen CSV as the request body.
 *
 * A row-level failure comes back as 422 WITH the report attached, and the
 * screen has to render that list — it is the whole point of the feature. So the
 * 422 is unwrapped here into a normal result rather than thrown: an operator
 * facing "31 rows are wrong" needs to see which 31.
 */
export function useProductImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ csv, dryRun, createMissingCategories }: ProductImportRequest) =>
      apiFetch<ProductImportResult>('/products/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        // `body` is JSON.stringify'd by apiFetch, so the raw CSV goes via
        // `rawBody` — see the apiFetch option below.
        rawBody: csv,
        searchParams: {
          dryRun: dryRun ? 'true' : undefined,
          createMissingCategories: createMissingCategories ? 'true' : undefined,
        },
        acceptStatuses: [422],
      }),
    onSuccess: (result) => {
      if (!result.dryRun && result.errors.length === 0) {
        void qc.invalidateQueries({ queryKey: ['products'] });
        void qc.invalidateQueries({ queryKey: ['item-categories'] });
      }
    },
  });
}
