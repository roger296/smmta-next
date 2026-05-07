import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface ChannelRow {
  id: string;
  slug: string;
  kind: 'STOREFRONT' | 'MARKETPLACE';
  displayName: string;
  isActive: boolean;
}

export interface ProductChannelRule {
  channelId: string;
  channelSlug: string;
  channelKind: 'STOREFRONT' | 'MARKETPLACE';
  channelDisplayName: string;
  isOffered: boolean;
  priceGbp: string;
  priceOverrideGbp: string | null;
}

export interface UpsertChannelRule {
  channelId: string;
  isOffered: boolean;
  priceOverrideGbp: string | null;
}

export function useChannels() {
  return useQuery<ChannelRow[]>({
    queryKey: ['channels'],
    queryFn: () => apiFetch<ChannelRow[]>('/channels'),
  });
}

export function useProductChannels(productId: string | undefined) {
  return useQuery<ProductChannelRule[]>({
    queryKey: ['products', 'detail', productId, 'channels'],
    queryFn: () => apiFetch<ProductChannelRule[]>(`/products/${productId}/channels`),
    enabled: !!productId,
  });
}

export function useUpdateProductChannels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      productId,
      input,
    }: {
      productId: string;
      input: { channels: UpsertChannelRule[] };
    }) =>
      apiFetch<ProductChannelRule[]>(`/products/${productId}/channels`, {
        method: 'PUT',
        body: input,
      }),
    onSuccess: (_data, { productId }) => {
      qc.invalidateQueries({ queryKey: ['products', 'detail', productId, 'channels'] });
    },
  });
}
