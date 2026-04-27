/**
 * StorefrontTab — DOM tests covering the Prompt 6 acceptance:
 *   - Publish toggle is disabled until slug + short description + hero image
 *     are all present (the publish-checklist gate).
 *   - When the gate passes, the toggle becomes enabled.
 *   - The colour swatch reflects the colourHex value.
 *
 * The component talks to the API via TanStack Query mutations; we wrap
 * the render in a fresh QueryClient so handlers don't bleed across tests.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { http, HttpResponse } from 'msw';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { server } from '@/test/mocks/server';
import { ToastContextProvider } from '@/hooks/use-toast';
import type { Product } from '@/lib/api-types';

// The StorefrontTab uses <Link to="/product-groups/new"> which requires a
// router context. We only need the link to render; the test does not exercise
// navigation, so a plain anchor is fine.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    ...rest
  }: { to: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { StorefrontTab } from './storefront-tab';

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return render(
    <ToastContextProvider>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </ToastContextProvider>,
  );
}

const API = 'http://localhost:8080/api/v1';

const baseProduct: Product = {
  id: 'p-1',
  companyId: 'c-1',
  name: 'Aurora Filament Lamp',
  stockCode: null,
  manufacturerId: null,
  manufacturerPartNumber: null,
  description: null,
  expectedNextCost: '0',
  minSellingPrice: null,
  maxSellingPrice: null,
  ean: null,
  productType: 'PHYSICAL',
  requireSerialNumber: false,
  requireBatchNumber: false,
  weight: null,
  length: null,
  width: null,
  height: null,
  countryOfOrigin: null,
  hsCode: null,
  supplierId: null,
  defaultWarehouseId: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  groupId: null,
  colour: null,
  colourHex: null,
  slug: null,
  shortDescription: null,
  longDescription: null,
  heroImageUrl: null,
  galleryImageUrls: null,
  seoTitle: null,
  seoDescription: null,
  seoKeywords: null,
  isPublished: false,
  sortOrderInGroup: 0,
};

function setupHandlers() {
  server.use(
    http.get(`${API}/product-groups`, () => HttpResponse.json({ success: true, data: [] })),
  );
}

describe('<StorefrontTab /> — publish-checklist gate', () => {
  it('disables the Published checkbox while required fields are missing', () => {
    setupHandlers();
    wrap(<StorefrontTab product={baseProduct} />);
    const checkbox = screen.getByRole('checkbox', { name: /Published/i });
    expect(checkbox).toBeDisabled();
    expect(screen.getByText(/0 of 7 storefront fields complete/i)).toBeInTheDocument();
    expect(screen.getByText(/Missing required:/i)).toBeInTheDocument();
  });

  it('enables the Published checkbox once slug + short description + hero image are all set', async () => {
    setupHandlers();
    wrap(<StorefrontTab product={baseProduct} />);

    // fireEvent.change beats userEvent.type here — the per-keystroke event
    // sequence interacts poorly with the Radix Select primitives mounted
    // elsewhere in the tab and pushes runtimes past the default test timeout.
    fireEvent.change(screen.getByLabelText(/URL slug/i), { target: { value: 'aurora-smoke' } });
    fireEvent.change(screen.getByLabelText(/Short description/i), {
      target: { value: 'A short tagline.' },
    });
    fireEvent.change(screen.getByLabelText(/Hero image URL/i), {
      target: { value: 'https://example.com/hero.jpg' },
    });

    const checkbox = screen.getByRole('checkbox', { name: /Published/i });
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    expect(screen.queryByText(/Missing required:/i)).not.toBeInTheDocument();
  });

  it('renders the colour swatch using the colourHex input value', () => {
    setupHandlers();
    wrap(<StorefrontTab product={{ ...baseProduct, colourHex: '#3a3a3a' }} />);
    const swatch = screen.getByLabelText('Colour preview');
    // jsdom may serialise CSS colour as either #hex or rgb() — accept both.
    const style = swatch.getAttribute('style') ?? '';
    expect(style).toMatch(/(3a3a3a|rgb\(\s*58,\s*58,\s*58\s*\))/i);
  });

  it('keeps the toggle enabled when the product is already published, even without all checklist items (no regressing operators)', () => {
    setupHandlers();
    wrap(
      <StorefrontTab
        product={{
          ...baseProduct,
          isPublished: true, // already published; we don't want to silently un-publish on render
        }}
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: /Published/i });
    expect(checkbox).not.toBeDisabled();
    expect(checkbox).toBeChecked();
  });
});
