/**
 * Stock-take row identity (Aug-2026 feedback set, D-1 / D-1b / D-3).
 *
 * "Every row read as a raw alphanumeric string, so no count could be logged."
 * The fix is that the line carries its own name — so the decisive test is the
 * one where the supplementary product lookup **fails outright** and the screen
 * is still legible.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

const TAKE = {
  take: { id: 'take-1' },
  lines: [
    { productId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', bookQty: '4000', productName: 'Icing sugar', stockCode: 'ING-ICING', stockUom: 'g', itemKind: 'INGREDIENT' },
    { productId: '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', bookQty: '9600', productName: 'Skittles', stockCode: 'ING-SKITTLE', stockUom: 'g', itemKind: 'INGREDIENT' },
    // No name at all — must still be legible, never a hex fragment.
    { productId: '2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', bookQty: '10', productName: null, stockCode: 'ING-MYSTERY', stockUom: 'g', itemKind: 'INGREDIENT' },
  ],
};

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

/** The supplementary lookup is deliberately broken in every test here. */
function breakProductMap() {
  server.use(
    http.get(`${API}/products`, () => HttpResponse.json({ success: false, error: 'boom' }, { status: 500 })),
  );
}

async function openTake(user: ReturnType<typeof userEvent.setup>) {
  server.use(http.post(`${API}/stock-takes`, () => HttpResponse.json({ success: true, data: TAKE })));
  await user.click(screen.getByRole('button', { name: /start count/i }));
  await screen.findByRole('button', { name: /save counts/i });
}

beforeEach(() => {
  localStorage.clear();
  breakProductMap();
});

describe('stock-take row identity (D-1)', () => {
  it('renders real product names with the product map deliberately failing', async () => {
    const user = userEvent.setup();
    renderScreen();
    await openTake(user);

    expect(screen.getByText('Icing sugar')).toBeInTheDocument();
    expect(screen.getByText('Skittles')).toBeInTheDocument();
  });

  it('D-1: no rendered row label is a bare hex fragment', async () => {
    const user = userEvent.setup();
    const { container } = renderScreen();
    await openTake(user);

    const labels = [...container.querySelectorAll('.row .name')].map((n) => n.textContent?.trim() ?? '');
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label, `"${label}" is the 12 Aug symptom`).not.toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('a nameless line says so legibly, with its stock code', async () => {
    const user = userEvent.setup();
    renderScreen();
    await openTake(user);
    expect(screen.getByText('Unknown product (ING-MYSTERY)')).toBeInTheDocument();
  });

  it('D-3: search matches the stock code as well as the name', async () => {
    const user = userEvent.setup();
    renderScreen();
    await openTake(user);

    const search = screen.getByPlaceholderText(/search items/i);
    await user.type(search, 'SKITTLE');
    expect(screen.getByText('Skittles')).toBeInTheDocument();
    expect(screen.queryByText('Icing sugar')).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'icing');
    expect(screen.getByText('Icing sugar')).toBeInTheDocument();
    expect(screen.queryByText('Skittles')).not.toBeInTheDocument();
  });

  it('shows "N of M counted" without needing the product map', async () => {
    const user = userEvent.setup();
    renderScreen();
    await openTake(user);
    expect(screen.getByText('0 / 3 counted')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /increase/i })[0]!);
    expect(screen.getByText('1 / 3 counted')).toBeInTheDocument();
  });
});
