/**
 * D-2 end-to-end regression: a 4 kg count submits as 4 (Aug-2026 feedback set).
 *
 * This is the test the 12 Aug session needed and did not have. It spies on the
 * ACTUAL request body that `useRecordStockTakeCounts` sends, because that is
 * where the loss happened — the number looked right on screen and was
 * destroyed on the way out.
 *
 * It fails against the pre-F4 code: with `bucketCount(qty, uom, quantum = 100)`
 * the body carried `countedQty: 0`.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { ToastContextProvider } from '@/hooks/use-toast';
import { StockTakeScreen } from './stock-take';

const API = 'http://localhost:8080/api/v1';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@tanstack/react-router');
  return { ...actual, createFileRoute: () => () => ({ component: null }), useNavigate: () => vi.fn() };
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

const ICING_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SCOOPED_ID = '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function takeFixture(countQuantum: string | null) {
  return {
    take: { id: 'take-1' },
    lines: [
      {
        productId: ICING_ID,
        bookQty: '5',
        productName: 'Icing sugar',
        stockCode: 'ING-ICING',
        stockUom: 'kg',
        itemKind: 'INGREDIENT',
        countQuantum: null,
      },
      {
        productId: SCOOPED_ID,
        bookQty: '900',
        productName: 'Plain flour (100 g scoop)',
        stockCode: 'ING-FLOUR',
        stockUom: 'g',
        itemKind: 'INGREDIENT',
        countQuantum,
      },
    ],
  };
}

interface CountsBody {
  counts: Array<{ productId: string; countedQty: number }>;
}

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastContextProvider>
        <StockTakeScreen />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
}

/** Open a take and return a promise resolving to the submitted counts body. */
async function openTakeCapturing(
  user: ReturnType<typeof userEvent.setup>,
  quantum: string | null,
): Promise<{ body: () => CountsBody | null }> {
  let captured: CountsBody | null = null;
  server.use(
    http.get(`${API}/products`, () =>
      HttpResponse.json({ success: true, data: [], total: 0, page: 1, pageSize: 250, totalPages: 1 }),
    ),
    http.post(`${API}/stock-takes`, () => HttpResponse.json({ success: true, data: takeFixture(quantum) })),
    http.post(`${API}/stock-takes/:id/counts`, async ({ request }) => {
      captured = (await request.json()) as CountsBody;
      return HttpResponse.json({ success: true, data: { recorded: captured.counts.length } });
    }),
  );
  await user.click(screen.getByRole('button', { name: /start count/i }));
  await screen.findByRole('button', { name: /save counts/i });
  return { body: () => captured };
}

/** Type an exact quantity into row `index` through the on-screen keypad. */
async function typeCount(user: ReturnType<typeof userEvent.setup>, index: number, digits: string) {
  await user.click(screen.getAllByRole('button', { name: /type quantity/i })[index]!);
  for (const d of digits) {
    // `name: new RegExp(...)` rather than `{ name: d, exact: true }` — the
    // latter is a getByText option, not a ByRole one.
    await user.click(screen.getByRole('button', { name: new RegExp(`^${d}$`) }));
  }
  await user.click(screen.getByRole('button', { name: /^save$/i }));
}

beforeEach(() => localStorage.clear());

describe('D-2: counts are not rounded to the nearest 100', () => {
  it('D-2 REGRESSION: a stock-take of 4 kg submits countedQty 4', async () => {
    const user = userEvent.setup();
    renderScreen();
    const capture = await openTakeCapturing(user, null);

    await typeCount(user, 0, '4');
    await user.click(screen.getByRole('button', { name: /save counts/i }));

    await waitFor(() => expect(capture.body()).not.toBeNull());
    const line = capture.body()!.counts.find((c) => c.productId === ICING_ID)!;
    // The whole defect, in one assertion. Pre-F4 this was 0.
    expect(line.countedQty).toBe(4);
  });

  it('a product WITH a configured quantum is still bucketed — opt-in works', async () => {
    const user = userEvent.setup();
    renderScreen();
    const capture = await openTakeCapturing(user, '100.0000');

    // Count the scooped-flour row (the second one) at 250 g.
    await typeCount(user, 1, '250');

    await user.click(screen.getByRole('button', { name: /save counts/i }));

    await waitFor(() => expect(capture.body()).not.toBeNull());
    const line = capture.body()!.counts.find((c) => c.productId === SCOOPED_ID)!;
    expect(line.countedQty).toBe(300);
  });

  it('a bucketed row SAYS it is bucketed', async () => {
    const user = userEvent.setup();
    renderScreen();
    await openTakeCapturing(user, '100.0000');
    expect(screen.getByText('rounded to nearest 100 g')).toBeInTheDocument();
  });

  it('an unbucketed row says nothing about rounding', async () => {
    const user = userEvent.setup();
    renderScreen();
    await openTakeCapturing(user, null);
    expect(screen.queryByText(/rounded to nearest/i)).not.toBeInTheDocument();
  });
});
