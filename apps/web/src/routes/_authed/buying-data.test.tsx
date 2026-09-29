/**
 * The Buying data page (supplier-ordering groundwork): each list shows its
 * full count, says why it matters, and says when it is only showing part.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import type { BuyingDataHealth, OptionRow } from '@/features/buying-data/use-buying-data';
import { BuyingDataPage } from './buying-data';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({ component: null }),
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  };
});

const API = 'http://localhost:8080/api/v1';

const option = (over: Partial<OptionRow> = {}): OptionRow => ({
  supplierProductId: 'sp-1',
  productId: 'p-1',
  productName: 'Caster Sugar',
  stockCode: 'CAST-SUGA',
  supplierId: 's-1',
  supplierName: 'Brakes',
  supplierSku: '5550',
  costGbp: '20.00',
  spendSeen12m: 480,
  lastPrice: '25.000000',
  lastPriceAt: '2026-07-01T12:00:00.000Z',
  previousPrice: '20.000000',
  ...over,
});

const HEALTH: BuyingDataHealth = {
  generatedAt: '2026-09-29T10:00:00.000Z',
  thresholds: { stalePriceDays: 60, priceMoveAlert: 0.1 },
  noBuyingOption: { total: 1, rows: [{ productId: 'p-9', productName: 'Rainbow Sprinkles', stockCode: null, hasReorderPoint: true }] },
  packSizeMissing: { total: 412, rows: [option()] },
  noPrice: { total: 0, rows: [] },
  stalePrice: { total: 1, rows: [option()] },
  priceMoves: { total: 1, rows: [{ ...option(), change: 0.25 }] },
  supplierAccounts: {
    total: 1,
    rows: [{ supplierId: 's-1', supplierName: 'Brakes', options: 180, venues: 5, venuesDatable: 1, spendSeen12m: 95000 }],
  },
};

function renderPage() {
  server.use(http.get(`${API}/buying-data/health`, () => HttpResponse.json({ success: true, data: HEALTH })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BuyingDataPage />
    </QueryClientProvider>,
  );
}

describe('Buying data page', () => {
  it('shows each list with its full count, and says when only part is shown', async () => {
    renderPage();
    const packs = await screen.findByTestId('pack-size-missing');
    expect(within(packs).getByText('412')).toBeInTheDocument();
    expect(within(packs).getByText('Showing the first 1 of 412.')).toBeInTheDocument();
    expect(within(packs).getByText('Caster Sugar')).toBeInTheDocument();
    expect(within(packs).getByText('£480.00')).toBeInTheDocument();
  });

  it('venues a supplier cannot be dated for', async () => {
    renderPage();
    const accounts = await screen.findByTestId('supplier-accounts');
    expect(within(accounts).getByText('1 of 5')).toBeInTheDocument();
  });

  it('a price move shows was, now and the change', async () => {
    renderPage();
    const moves = await screen.findByTestId('price-moves');
    expect(within(moves).getByText('£20.00')).toBeInTheDocument();
    expect(within(moves).getByText('£25.00')).toBeInTheDocument();
    expect(within(moves).getByText('+25%')).toBeInTheDocument();
  });

  it('an empty list says so rather than showing an empty table', async () => {
    renderPage();
    const none = await screen.findByTestId('no-price');
    expect(within(none).getByText('Nothing here.')).toBeInTheDocument();
    expect(within(none).queryByRole('table')).not.toBeInTheDocument();
  });

  it('flags a stocked product with a reorder point and no supplier', async () => {
    renderPage();
    const orphans = await screen.findByTestId('no-buying-option');
    expect(within(orphans).getByText('has a reorder point')).toBeInTheDocument();
  });
});
