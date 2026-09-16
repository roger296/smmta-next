import { useMutation } from '@tanstack/react-query';
import { apiFetchBlob, triggerBlobDownload } from '@/lib/api-client';

/** Fallback when the response carries no Content-Disposition filename. */
export function fallbackExportFilename(now = new Date()): string {
  return `products-${now.toISOString().slice(0, 10)}.csv`;
}

/**
 * Downloads the whole catalogue as a CSV.
 *
 * A mutation rather than a query on purpose: this is an action the operator
 * takes, it must not run on mount, and it must not be cached — a cached export
 * would hand back yesterday's catalogue after somebody had spent the morning
 * editing it.
 */
export function useProductExport() {
  return useMutation({
    mutationFn: async () => {
      const { blob, filename } = await apiFetchBlob('/products/export.csv');
      triggerBlobDownload(blob, filename ?? fallbackExportFilename());
    },
  });
}
