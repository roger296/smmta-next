/**
 * A code that finds nothing is a fork, not a dead end (Aug-2026, C-3).
 *
 * "Manual barcode entry failed to find the product for an icing sugar
 * delivery." The old behaviour was a destructive toast and nothing else. Two
 * ways forward now: find it by name, or put the code on it so the next
 * delivery scans first time.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { ToastContextProvider } from '@/hooks/use-toast';
import { tokenWithRoles } from '@/test/tokens';
import { GoodsInScreen } from './goods-in';

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
    source: 'device',
    isBound: true,
  }),
  SiteProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const ICING = {
  id: 'prod-icing',
  name: 'Icing sugar',
  stockCode: 'ING-ICING',
  barcode: null,
  stockUom: 'g',
  purchaseUom: '25 kg sack',
  purchaseToStockFactor: '25000',
  expectedNextCost: '0.0012',
  requireBatchNumber: false,
};

const MISSING_CODE = '5012345678900';

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastContextProvider>
        <GoodsInScreen />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
}

/**
 * The code resolves to nothing — the 12 Aug situation.
 *
 * The search stub answers by TERM, not blanket: searching the unknown code
 * must find nothing (otherwise the resolver's `candidates[0]` fallback picks
 * something and there is no miss to test), while searching by name finds the
 * product. That asymmetry is the real one — the code is not recorded anywhere,
 * which is exactly why the scan missed.
 */
function stubMiss(nameResults: unknown[] = []) {
  server.use(
    http.get(`${API}/products/by-code/:code`, () =>
      HttpResponse.json({ success: false, error: 'not found' }, { status: 404 }),
    ),
    http.get(`${API}/products`, ({ request }) => {
      const term = new URL(request.url).searchParams.get('search') ?? '';
      const data = term === MISSING_CODE ? [] : nameResults;
      return HttpResponse.json({
        success: true,
        data,
        total: data.length,
        page: 1,
        pageSize: 50,
        totalPages: 1,
      });
    }),
  );
}

async function enterMissingCode(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/product code/i), MISSING_CODE);
  await user.click(screen.getByRole('button', { name: /\+ add/i }));
  await screen.findByText(`Nothing found for "${MISSING_CODE}"`);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('smmta_token', tokenWithRoles(['site_manager'], SITE.id));
});

describe('C-3: a miss offers a way forward', () => {
  it('opens the sheet instead of only toasting', async () => {
    const user = userEvent.setup();
    stubMiss();
    renderScreen();
    await enterMissingCode(user);

    expect(screen.getByLabelText(/search products by name/i)).toBeInTheDocument();
  });

  it('name search returns a pickable list — Goods In had no name search at all', async () => {
    const user = userEvent.setup();
    stubMiss([ICING]);
    renderScreen();
    await enterMissingCode(user);

    await user.type(screen.getByLabelText(/search products by name/i), 'icing sugar');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    expect(await screen.findByText('Icing sugar')).toBeInTheDocument();
    // "no barcode yet" — the reason the scan missed, stated plainly.
    expect(screen.getByText(/no barcode yet/i)).toBeInTheDocument();
  });

  it('picking a result adds the line', async () => {
    const user = userEvent.setup();
    stubMiss([ICING]);
    renderScreen();
    await enterMissingCode(user);

    await user.type(screen.getByLabelText(/search products by name/i), 'icing');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await user.click(await screen.findByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      expect(screen.queryByText(`Nothing found for "${MISSING_CODE}"`)).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Icing sugar')).toBeInTheDocument();
  });

  it('C-3: "Add code" attaches the scanned code, so the next delivery scans first time', async () => {
    const user = userEvent.setup();
    stubMiss([ICING]);
    let attached: { id: string; barcode: string } | null = null;
    server.use(
      http.post(`${API}/products/:id/barcode`, async ({ params, request }) => {
        const body = (await request.json()) as { barcode: string };
        attached = { id: params.id as string, barcode: body.barcode };
        return HttpResponse.json({ success: true, data: { ...ICING, barcode: body.barcode } });
      }),
    );
    renderScreen();
    await enterMissingCode(user);

    await user.type(screen.getByLabelText(/search products by name/i), 'icing');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await user.click(await screen.findByRole('button', { name: new RegExp(`put code ${MISSING_CODE}`, 'i') }));

    await waitFor(() => expect(attached).toEqual({ id: 'prod-icing', barcode: MISSING_CODE }));
    // And the line is added in the same motion — nobody has to search twice.
    expect(await screen.findByText('Icing sugar')).toBeInTheDocument();
  });

  it('a conflict when attaching is surfaced, not swallowed', async () => {
    const user = userEvent.setup();
    stubMiss([ICING]);
    server.use(
      http.post(`${API}/products/:id/barcode`, () =>
        HttpResponse.json(
          { success: false, error: 'Barcode 5012345678900 is already on "Caster sugar".' },
          { status: 409 },
        ),
      ),
    );
    renderScreen();
    await enterMissingCode(user);

    await user.type(screen.getByLabelText(/search products by name/i), 'icing');
    await user.click(screen.getByRole('button', { name: /^search$/i }));
    await user.click(await screen.findByRole('button', { name: new RegExp(`put code ${MISSING_CODE}`, 'i') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already on "Caster sugar"/);
  });

  it('says so when the name search itself finds nothing', async () => {
    const user = userEvent.setup();
    stubMiss([]);
    renderScreen();
    await enterMissingCode(user);

    await user.type(screen.getByLabelText(/search products by name/i), 'nonsense');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    expect(await screen.findByText(/nothing matches "nonsense"/i)).toBeInTheDocument();
  });
});
