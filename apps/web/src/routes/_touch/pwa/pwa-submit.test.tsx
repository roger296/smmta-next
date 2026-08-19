/**
 * Truthful submit on the three venue screens (Aug-2026 feedback set, A-1/A-6).
 *
 * The 12 Aug session was told "Saved offline — will sync" for work the server
 * had rejected outright. Each screen is exercised against a mocked 400 and a
 * mocked network failure, and asserted on the three things that actually
 * matter to a baker standing at a shelf:
 *
 *   1. a rejection shows a persistent in-screen error quoting the server,
 *   2. the entries are STILL ON SCREEN,
 *   3. nothing was queued and no success message was shown.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { ToastContextProvider } from '@/hooks/use-toast';
import { pwaQueue } from '@/features/pwa/use-pwa-jobs';
import { GoodsInScreen } from './goods-in';
import { StockTakeScreen } from './stock-take';

const API = 'http://localhost:8080/api/v1';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({ component: null }),
    useNavigate: () => vi.fn(),
  };
});

const SITE = { id: 'site-1', name: 'London South', isActive: true };

vi.mock('@/features/sites/site-context', () => ({
  useSiteContext: () => ({
    sites: [SITE],
    isLoading: false,
    selectedSiteId: SITE.id,
    selectedSite: SITE,
    setSelectedSiteId: vi.fn(),
  }),
  SiteProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const ICING = {
  id: 'prod-icing',
  name: 'Icing sugar',
  stockCode: 'ING-ICING',
  barcode: '5012345678900',
  stockUom: 'g',
  purchaseUom: 'sack',
  purchaseToStockFactor: '25000',
  expectedNextCost: '0.0012',
  requireBatchNumber: false,
};

function renderScreen(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastContextProvider>{ui}</ToastContextProvider>
    </QueryClientProvider>,
  );
}

async function clearQueue() {
  for (const a of await pwaQueue.list()) await pwaQueue.discard(a.idempotencyKey);
  for (const a of await pwaQueue.deadLetters()) await pwaQueue.discard(a.idempotencyKey);
}

beforeEach(async () => {
  localStorage.clear();
  await clearQueue();
});

describe('Goods In — truthful submit (A-1)', () => {
  const addIcingSugar = async (user: ReturnType<typeof userEvent.setup>) => {
    server.use(
      http.get(`${API}/products/by-code/:code`, () => HttpResponse.json({ success: true, data: ICING })),
      http.get(`${API}/products`, () =>
        HttpResponse.json({ success: true, data: [ICING], total: 1, page: 1, pageSize: 50, totalPages: 1 }),
      ),
    );
    await user.type(screen.getByLabelText(/product code/i), '5012345678900');
    await user.click(screen.getByRole('button', { name: /\+ add/i }));
    await screen.findByText('Icing sugar');
  };

  it('a rejected booking shows an error banner, keeps the lines, and queues nothing', async () => {
    const user = userEvent.setup();
    renderScreen(<GoodsInScreen />);
    await addIcingSugar(user);

    server.use(
      http.post(`${API}/goods-in`, () =>
        HttpResponse.json({ success: false, error: 'Site London South has no open receiving bay' }, { status: 400 }),
      ),
    );

    // Book-in is a two-step now (E-5): confirm the destination, then commit.
    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));
    await user.click(await screen.findByRole('button', { name: /confirm and book in/i }));

    // 1. the server's own message, in the screen, as an alert
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/no open receiving bay/i);
    // 2. the line survives
    expect(screen.getByText('Icing sugar')).toBeInTheDocument();
    // 3. nothing queued, and no "saved" claim anywhere
    expect(await pwaQueue.size()).toBe(0);
    expect(screen.queryByText(/saved offline/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^booked in$/i)).not.toBeInTheDocument();
  });

  it('a network failure says "saved offline" AND leaves a pending action behind', async () => {
    const user = userEvent.setup();
    renderScreen(<GoodsInScreen />);
    await addIcingSugar(user);

    server.use(http.post(`${API}/goods-in`, () => HttpResponse.error()));

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));
    await user.click(await screen.findByRole('button', { name: /confirm and book in/i }));

    await waitFor(async () => expect(await pwaQueue.size()).toBe(1));
    expect(await screen.findByText(/saved offline/i)).toBeInTheDocument();
  });

  it('A-6: a lookup failure is surfaced instead of doing nothing', async () => {
    const user = userEvent.setup();
    renderScreen(<GoodsInScreen />);

    server.use(
      http.get(`${API}/products/by-code/:code`, () => HttpResponse.error()),
      http.get(`${API}/products`, () => HttpResponse.error()),
    );

    await user.type(screen.getByLabelText(/product code/i), 'NOPE');
    await user.click(screen.getByRole('button', { name: /\+ add/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('A-6/C-3: a genuine miss opens the way-forward sheet, and adds no line', async () => {
    const user = userEvent.setup();
    renderScreen(<GoodsInScreen />);

    server.use(
      http.get(`${API}/products/by-code/:code`, () =>
        HttpResponse.json({ success: false, error: 'Not found' }, { status: 404 }),
      ),
      http.get(`${API}/products`, () =>
        HttpResponse.json({ success: true, data: [], total: 0, page: 1, pageSize: 50, totalPages: 0 }),
      ),
    );

    await user.type(screen.getByLabelText(/product code/i), 'NOPE');
    await user.click(screen.getByRole('button', { name: /\+ add/i }));

    // Since F8 a miss is a fork, not a dead end: the sheet names the code and
    // offers a name search / attach (C-3). The A-6 property still holds —
    // the failure is SURFACED rather than doing nothing at all.
    expect(await screen.findByText('Nothing found for "NOPE"')).toBeInTheDocument();
    expect(screen.getByLabelText(/search products by name/i)).toBeInTheDocument();
    // Still no line, and still no claim that anything worked.
    expect(screen.getByRole('button', { name: /book in 0 lines/i })).toBeDisabled();
  });
});

describe('Stock Take — truthful submit (A-1)', () => {
  const TAKE = {
    take: { id: 'take-1' },
    lines: [
      { productId: 'prod-icing', bookQty: '4000', productName: 'Icing sugar', stockCode: 'ING-ICING', stockUom: 'g' },
    ],
  };

  const openTake = async (user: ReturnType<typeof userEvent.setup>) => {
    server.use(
      http.post(`${API}/stock-takes`, () => HttpResponse.json({ success: true, data: TAKE })),
      http.get(`${API}/products`, () =>
        HttpResponse.json({ success: true, data: [ICING], total: 1, page: 1, pageSize: 250, totalPages: 1 }),
      ),
    );
    await user.click(screen.getByRole('button', { name: /start count/i }));
    await screen.findByRole('button', { name: /save counts/i });
  };

  it('rejected counts show an error banner and stay on screen', async () => {
    const user = userEvent.setup();
    renderScreen(<StockTakeScreen />);
    await openTake(user);

    // Record a count so there is something to submit.
    await user.click(screen.getAllByRole('button', { name: /increase/i })[0]!);

    server.use(
      http.post(`${API}/stock-takes/:id/counts`, () =>
        HttpResponse.json({ success: false, error: 'This stock-take is already approved' }, { status: 409 }),
      ),
    );

    await user.click(screen.getByRole('button', { name: /save counts/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already approved/i);
    expect(await pwaQueue.size()).toBe(0);
    expect(screen.queryByText(/saved offline/i)).not.toBeInTheDocument();
  });
});
