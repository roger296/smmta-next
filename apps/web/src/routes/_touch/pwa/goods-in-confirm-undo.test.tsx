/**
 * Booking confirmation and undo (Aug-2026 feedback set, E-5 / E-3).
 *
 * "Accidental booking logged 100kg to Birmingham; requested an undo timer or
 * role-based permission locks."
 *
 * Two independent safeguards, tested independently: the confirmation restates
 * the DESTINATION before anything is written, and the undo issues a reversing
 * receipt after it has been.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { ToastContextProvider } from '@/hooks/use-toast';
import { pwaQueue } from '@/features/pwa/use-pwa-jobs';
import { tokenWithRoles } from '@/test/tokens';
import { GoodsInScreen } from './goods-in';

const API = 'http://localhost:8080/api/v1';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@tanstack/react-router');
  return { ...actual, createFileRoute: () => () => ({ component: null }), useNavigate: () => vi.fn() };
});

const SITE = { id: 'site-london-south', name: 'London South', isActive: true };
let mockBound = true;
vi.mock('@/features/sites/site-context', () => ({
  useSiteContext: () => ({
    sites: [SITE],
    isLoading: false,
    selectedSiteId: SITE.id,
    selectedSite: SITE,
    setSelectedSiteId: vi.fn(),
    source: mockBound ? 'device' : 'default',
    isBound: mockBound,
  }),
  SiteProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const ICING = {
  id: 'prod-icing',
  name: 'Icing sugar',
  stockCode: 'ING-ICING',
  barcode: '5012345678900',
  stockUom: 'g',
  purchaseUom: '25 kg sack',
  purchaseToStockFactor: '25000',
  expectedNextCost: '0.0012',
  requireBatchNumber: false,
};

const RECEIPT = {
  receipt: {
    id: 'receipt-1',
    siteId: SITE.id,
    reference: null,
    totalStockValue: '120.00',
    receivedAt: '2026-08-19T10:00:00.000Z',
  },
  lines: [],
  alreadyExisted: false,
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

async function addIcing(user: ReturnType<typeof userEvent.setup>, packs = 4) {
  server.use(
    http.get(`${API}/products/by-code/:code`, () => HttpResponse.json({ success: true, data: ICING })),
    http.get(`${API}/products`, () =>
      HttpResponse.json({ success: true, data: [ICING], total: 1, page: 1, pageSize: 50, totalPages: 1 }),
    ),
  );
  await user.type(screen.getByLabelText(/product code/i), '5012345678900');
  await user.click(screen.getByRole('button', { name: /\+ add/i }));
  await screen.findByText('Icing sugar');
  for (let i = 1; i < packs; i += 1) {
    await user.click(screen.getByRole('button', { name: /^increase$/i }));
  }
}

beforeEach(async () => {
  localStorage.clear();
  // Undo issues a reversing receipt, which is site_manager+ (E-4), so the UI
  // only offers it to one. The refusal path has its own spec below.
  localStorage.setItem('smmta_token', tokenWithRoles(['site_manager'], SITE.id));
  mockBound = true;
  vi.useRealTimers();
  for (const a of await pwaQueue.list()) await pwaQueue.discard(a.idempotencyKey);
});

afterEach(() => vi.useRealTimers());

describe('E-5: confirm the destination before booking', () => {
  it('the confirmation names the venue, large, before anything is written', async () => {
    const user = userEvent.setup();
    let posted = false;
    server.use(
      http.post(`${API}/goods-in`, () => {
        posted = true;
        return HttpResponse.json({ success: true, data: RECEIPT });
      }),
    );
    renderScreen();
    await addIcing(user);

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));

    expect(await screen.findByText('Book this delivery in?')).toBeInTheDocument();
    // Scoped to the sheet: the venue is deliberately also in the topbar chip,
    // so an unscoped query matches both.
    expect(document.querySelector('.confirm-venue-name')).toHaveTextContent('London South');
    // Nothing has been booked yet — that is the entire point of the step.
    expect(posted).toBe(false);
  });

  it('restates each line the way a human checks it', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addIcing(user, 4);

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));

    // "4 × 25 kg sack = 100000 g" — quantity, pack, and the resolved stock qty.
    expect(await screen.findByText(/4 × 25 kg sack = 100000 g/)).toBeInTheDocument();
  });

  it('cancel returns with the entries intact', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addIcing(user);

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByText('Book this delivery in?')).not.toBeInTheDocument();
    expect(screen.getByText('Icing sugar')).toBeInTheDocument();
  });

  it('warns when the venue was defaulted rather than bound to the device', async () => {
    mockBound = false;
    const user = userEvent.setup();
    renderScreen();
    await addIcing(user);

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));

    await screen.findByText('Book this delivery in?');
    expect(document.querySelector('.confirm-venue-warn')).toHaveTextContent(/not set for this device/i);
    expect(document.querySelector('.confirm-venue-name')).toHaveClass('warn');
  });
});

describe('E-3: the undo window', () => {
  it('a successful booking offers Undo, naming the venue', async () => {
    const user = userEvent.setup();
    server.use(http.post(`${API}/goods-in`, () => HttpResponse.json({ success: true, data: RECEIPT })));
    renderScreen();
    await addIcing(user);

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));
    await user.click(await screen.findByRole('button', { name: /confirm and book in/i }));

    expect(await screen.findByText('Booked to London South')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^undo$/i })).toBeInTheDocument();
  });

  it('tapping Undo fires the reversal for that receipt', async () => {
    const user = userEvent.setup();
    let reversed: string | null = null;
    server.use(
      http.post(`${API}/goods-in`, () => HttpResponse.json({ success: true, data: RECEIPT })),
      http.post(`${API}/goods-in/:id/reverse`, ({ params }) => {
        reversed = params.id as string;
        return HttpResponse.json({ success: true, data: { reversal: { id: 'rev-1' } } });
      }),
    );
    renderScreen();
    await addIcing(user);

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));
    await user.click(await screen.findByRole('button', { name: /confirm and book in/i }));
    await user.click(await screen.findByRole('button', { name: /^undo$/i }));

    await waitFor(() => expect(reversed).toBe('receipt-1'));
    // The bar goes once the reversal lands.
    await waitFor(() => expect(screen.queryByText('Booked to London South')).not.toBeInTheDocument());
  });

  it('a refused reversal is surfaced, not swallowed', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/goods-in`, () => HttpResponse.json({ success: true, data: RECEIPT })),
      http.post(`${API}/goods-in/:id/reverse`, () =>
        HttpResponse.json(
          { success: false, error: 'This needs a site manager. You are signed in as a head baker.' },
          { status: 403 },
        ),
      ),
    );
    renderScreen();
    await addIcing(user);

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));
    await user.click(await screen.findByRole('button', { name: /confirm and book in/i }));
    await user.click(await screen.findByRole('button', { name: /^undo$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/site manager/i);
  });

  it('E-4: a head baker is not offered an Undo they would only be refused', async () => {
    localStorage.setItem('smmta_token', tokenWithRoles(['head_baker'], SITE.id));
    const user = userEvent.setup();
    server.use(http.post(`${API}/goods-in`, () => HttpResponse.json({ success: true, data: RECEIPT })));
    renderScreen();
    await addIcing(user);

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));
    await user.click(await screen.findByRole('button', { name: /confirm and book in/i }));

    // The booking still happens; only the reversal affordance is withheld.
    await waitFor(() => expect(screen.queryByText('Icing sugar')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^undo$/i })).not.toBeInTheDocument();
  });

  it('a QUEUED booking offers no Undo — there is no receipt to reverse yet', async () => {
    const user = userEvent.setup();
    server.use(http.post(`${API}/goods-in`, () => HttpResponse.error()));
    renderScreen();
    await addIcing(user);

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));
    await user.click(await screen.findByRole('button', { name: /confirm and book in/i }));

    await waitFor(async () => expect(await pwaQueue.size()).toBe(1));
    // Offering an undo for work that has not reached the server would be the
    // A-1 lie in a different costume.
    expect(screen.queryByRole('button', { name: /^undo$/i })).not.toBeInTheDocument();
  });
});
