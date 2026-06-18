import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type ImageCaptureSource = 'REFERENCE' | 'GOODS_IN' | 'STOCK_TAKE' | 'CONSUMPTION' | 'SHELF';

export interface ImageCapture {
  id: string;
  productId: string | null;
  siteId: string | null;
  source: ImageCaptureSource;
  imageRef: string;
  label: string | null;
  sourceRef: string | null;
  capturedAt: string;
}

/** Admin gallery of the accumulating image set (P23, AI groundwork). */
export function useImageGallery(filter?: { productId?: string; siteId?: string; source?: ImageCaptureSource }) {
  return useQuery<ImageCapture[]>({
    queryKey: ['image-captures', filter ?? {}],
    queryFn: () => apiFetch<ImageCapture[]>('/image-captures', { searchParams: filter }),
  });
}
