import * as React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithQueryClient(
  ui: React.ReactElement,
  options: { client?: QueryClient } & Omit<RenderOptions, 'wrapper'> = {},
) {
  const { client = makeQueryClient(), ...rest } = options;
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper, ...rest });
}
