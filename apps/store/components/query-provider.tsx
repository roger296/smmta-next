'use client';

/**
 * TanStack Query provider for the storefront's client islands (cart drawer,
 * cart page mutations). The QueryClient is constructed lazily inside the
 * component so each browser session gets its own instance and tests don't
 * share state between renders.
 */
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // Don't auto-refetch the cart on every focus — adds noise without
            // value. The cart page invalidates explicitly after mutations.
            refetchOnWindowFocus: false,
            retry: 1,
          },
          mutations: { retry: 0 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
