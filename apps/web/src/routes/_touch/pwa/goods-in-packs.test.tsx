/**
 * Purchase units on the Goods In screen (Aug-2026, C-1/C-2/C-6).
 *
 * "Icing sugar displayed an incorrect default unit quantity of 1kg."
 * "Skittles displayed an incorrect base unit, preventing the 1.6kg bags from
 *  being added."
 * "Request to add base-unit increment buttons (e.g. auto-filling to 25kg and
 *  adding +25kg per click)."
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

/** The fixture shape, with the nullable purchase fields explicit. */
interface Fixture {
  id: string;
  name: string;
  stockCode: string;
  barcode: string;
  stockUom: string;
  purchaseUom: string | null;
  packDescription: string | null;
  purchaseToStockFactor: string;
  expectedNextCost: string;
  requireBatchNumber: boolean;
}

const ICING: Fixture = {
  id: 'prod-icing',
  name: 'Icing sugar',
  stockCode: 'ING-ICING',
  barcode: '5012345678900',
  stockUom: 'g',
  purchaseUom: 'sack',
  packDescription: '25 kg sack',
  purchaseToStockFactor: '25000',
  expectedNextCost: '30.000000',
  requireBatchNumber: false,
};

/** Exactly as the 12 Aug seed left it: grams, no purchase unit, factor 1. */
const UNCONFIGURED: Fixture = {
  ...ICING,
  id: 'prod-unconfigured',
  name: 'Unconfigured sugar',
  barcode: '1111111111111',
  purchaseUom: null,
  packDescription: null,
  purchaseToStockFactor: '1',
  expectedNextCost: '0',
};

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

async function add(user: ReturnType<typeof userEvent.setup>, product: Fixture) {
  server.use(
    http.get(`${API}/products/by-code/:code`, () => HttpResponse.json({ success: true, data: product })),
  );
  await user.clear(screen.getByLabelText(/product code/i));
  await user.type(screen.getByLabelText(/product code/i), product.barcode);
  await user.click(screen.getByRole('button', { name: /\+ add/i }));
  await screen.findByText(product.name);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('smmta_token', tokenWithRoles(['site_manager'], SITE.id));
});

describe('C-1/C-2: the line reads in the unit a human uses', () => {
  it('C-1 REGRESSION: a 25 kg sack does NOT read "= 1 g"', async () => {
    const user = userEvent.setup();
    renderScreen();
    await add(user, ICING);

    const hint = document.querySelector('.touch-app .row .hint')!;
    expect(hint).toHaveTextContent('1 × 25 kg sack = 25 kg');
    expect(hint).not.toHaveTextContent('= 1 g');
  });

  it('C-4: the cost is not £0.00 — it shows per pack AND per stock unit', async () => {
    const user = userEvent.setup();
    renderScreen();
    await add(user, ICING);

    const hint = document.querySelector('.touch-app .row .hint')!;
    expect(hint).toHaveTextContent('£30.00/sack');
    // £30 a sack over 25000 g is £0.0012/g — which 2dp formatting rendered as
    // the £0.00 the tester reported.
    expect(hint).toHaveTextContent('£0.0012/g');
  });

  it('C-1: a product with no purchase unit shows the blocked state, not "= 1 g"', async () => {
    const user = userEvent.setup();
    renderScreen();
    await add(user, UNCONFIGURED);

    const hint = document.querySelector('.touch-app .row .hint')!;
    expect(hint).toHaveTextContent('no purchase unit set');
    expect(hint).toHaveTextContent('no purchase unit — set one to book this in');
  });

  it('C-1: a blocked line blocks the booking rather than booking 1 g', async () => {
    const user = userEvent.setup();
    renderScreen();
    await add(user, UNCONFIGURED);

    const book = screen.getByRole('button', { name: /need a purchase unit/i });
    expect(book).toBeDisabled();
  });

  it('a configured line does not block the booking', async () => {
    const user = userEvent.setup();
    renderScreen();
    await add(user, ICING);
    expect(screen.getByRole('button', { name: /book in 1 line/i })).toBeEnabled();
  });
});

describe('C-6: base-unit increment buttons', () => {
  it('the buttons are labelled with the pack — "+1 sack", not "+1"', async () => {
    const user = userEvent.setup();
    renderScreen();
    await add(user, ICING);

    expect(screen.getByRole('button', { name: /add one sack of Icing sugar/i })).toHaveTextContent(
      '+1 sack',
    );
    expect(
      screen.getByRole('button', { name: /remove one sack of Icing sugar/i }),
    ).toHaveTextContent('−1 sack');
  });

  it('C-6: each press steps by one whole pack — 25 kg at a time', async () => {
    const user = userEvent.setup();
    renderScreen();
    await add(user, ICING);

    const plus = screen.getByRole('button', { name: /add one sack of Icing sugar/i });
    await user.click(plus);
    await user.click(plus);
    await user.click(plus);

    // 4 sacks — the 12 Aug delivery.
    const hint = document.querySelector('.touch-app .row .hint')!;
    await waitFor(() => expect(hint).toHaveTextContent('4 × 25 kg sack = 100 kg'));
  });

  it('never steps below zero', async () => {
    const user = userEvent.setup();
    renderScreen();
    await add(user, ICING);

    const minus = screen.getByRole('button', { name: /remove one sack of Icing sugar/i });
    await user.click(minus);
    await user.click(minus);

    const hint = document.querySelector('.touch-app .row .hint')!;
    expect(hint).toHaveTextContent('0 × 25 kg sack = 0 g');
  });

  it('the pack buttons are disabled on a blocked line', async () => {
    const user = userEvent.setup();
    renderScreen();
    await add(user, UNCONFIGURED);
    expect(screen.getByRole('button', { name: /add one pack of/i })).toBeDisabled();
  });
});

describe('C-5: setting the expected cost from the venue screen', () => {
  it('writes the cost back to the product', async () => {
    const user = userEvent.setup();
    let saved: number | null = null;
    server.use(
      http.put(`${API}/products/:id`, async ({ request }) => {
        const body = (await request.json()) as { expectedNextCost: number };
        saved = body.expectedNextCost;
        return HttpResponse.json({ success: true, data: { ...ICING, expectedNextCost: String(body.expectedNextCost) } });
      }),
    );
    renderScreen();
    await add(user, ICING);

    await user.click(screen.getByRole('button', { name: /cost & batch details/i }));
    const cost = await screen.findByLabelText(/unit cost/i);
    await user.clear(cost);
    await user.type(cost, '32.5');
    await user.click(screen.getByRole('button', { name: /save as this product/i }));

    await waitFor(() => expect(saved).toBe(32.5));
  });

  it('E-4: a head baker is not shown the cost write-back at all', async () => {
    localStorage.setItem('smmta_token', tokenWithRoles(['head_baker'], SITE.id));
    const user = userEvent.setup();
    renderScreen();
    await add(user, ICING);

    await user.click(screen.getByRole('button', { name: /cost & batch details/i }));
    await screen.findByLabelText(/unit cost/i);
    expect(screen.queryByRole('button', { name: /save as this product/i })).not.toBeInTheDocument();
  });
});
