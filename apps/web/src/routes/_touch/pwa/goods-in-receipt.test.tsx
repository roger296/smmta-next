/**
 * The receipt and the exit guards (Aug-2026 feedback set, A-5).
 *
 * "Request clear visual feedback upon booking rather than having items
 * immediately clear from view."
 * "Lack of visual feedback on screen exits leaves users uncertain whether
 * inputs are saved, deleted, or processed."
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { ToastContextProvider } from '@/hooks/use-toast';
import { tokenWithRoles } from '@/test/tokens';
import { draftKey } from '@/lib/draft-store';
import { GoodsInScreen } from './goods-in';

const API = 'http://localhost:8080/api/v1';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({ component: null }),
    useNavigate: () => navigate,
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
    source: 'device',
    isBound: true,
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
  packDescription: '25 kg sack',
  purchaseToStockFactor: '25000',
  expectedNextCost: '30.000000',
  requireBatchNumber: false,
};

const RECEIPT = {
  receipt: {
    id: 'receipt-1',
    siteId: SITE.id,
    reference: 'GRN-0042',
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
  );
  await user.type(screen.getByLabelText(/product code/i), '5012345678900');
  await user.click(screen.getByRole('button', { name: /\+ add/i }));
  await screen.findByText('Icing sugar');
  for (let i = 1; i < packs; i += 1) {
    await user.click(screen.getByRole('button', { name: /add one sack of Icing sugar/i }));
  }
}

async function book(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /book in 1 line/i }));
  await user.click(await screen.findByRole('button', { name: /confirm and book in/i }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('smmta_token', tokenWithRoles(['site_manager'], SITE.id));
  navigate.mockClear();
  server.use(http.post(`${API}/goods-in`, () => HttpResponse.json({ success: true, data: RECEIPT })));
});

describe('A-5: the booking leaves a receipt, not a vanishing list', () => {
  it('shows every line as booked, with the venue and the reference', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addIcing(user, 4);
    await book(user);

    expect(await screen.findByRole('button', { name: /book another delivery/i })).toBeInTheDocument();
    expect(document.querySelector('.receipt-title')).toHaveTextContent('Booked to London South');
    expect(document.querySelector('.receipt-sub')).toHaveTextContent('GRN-0042');
    // The lines are still legible, in the same phrasing as before booking.
    expect(screen.getByText('Icing sugar')).toBeInTheDocument();
    expect(screen.getByText(/4 × 25 kg sack = 100 kg/)).toBeInTheDocument();
    expect(screen.getByText('£120.00')).toBeInTheDocument();
  });

  it('the receipt does not disappear on its own — the user leaves it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderScreen();
    await addIcing(user, 1);
    await book(user);
    await screen.findByRole('button', { name: /book another delivery/i });

    // Well past the 90-second undo window. Wrapped in act() so the interval's
    // state updates are flushed before the assertions read the DOM.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(screen.getByRole('button', { name: /book another delivery/i })).toBeInTheDocument();
    // Only the undo bar expires.
    expect(screen.queryByRole('button', { name: /^undo$/i })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('"Book another delivery" returns to an empty form', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addIcing(user, 1);
    await book(user);

    await user.click(await screen.findByRole('button', { name: /book another delivery/i }));

    expect(screen.getByLabelText(/product code/i)).toBeInTheDocument();
    expect(screen.queryByText('Icing sugar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /book in 0 lines/i })).toBeDisabled();
  });

  it('"Done" leaves the screen', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addIcing(user, 1);
    await book(user);

    await user.click(await screen.findByRole('button', { name: /^done$/i }));
    expect(navigate).toHaveBeenCalledWith({ to: '/venue' });
  });
});

describe('A-5: exit guards', () => {
  it('Back with unbooked lines asks first', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addIcing(user, 1);

    await user.click(screen.getByRole('button', { name: /^back$/i }));

    expect(await screen.findByText('Leave without booking in?')).toBeInTheDocument();
    expect(screen.getByText(/1 line not yet booked in/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('"Keep editing" retains the lines', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addIcing(user, 1);

    await user.click(screen.getByRole('button', { name: /^back$/i }));
    await user.click(await screen.findByRole('button', { name: /keep editing/i }));

    expect(screen.getByText('Icing sugar')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('"Discard them" clears and leaves', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addIcing(user, 1);

    await user.click(screen.getByRole('button', { name: /^back$/i }));
    await user.click(await screen.findByRole('button', { name: /discard them/i }));

    expect(navigate).toHaveBeenCalledWith({ to: '/venue' });
    expect(localStorage.getItem(draftKey('goods-in', SITE.id))).toBeNull();
  });

  it('Back with nothing entered just leaves', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(screen.getByRole('button', { name: /^back$/i }));
    expect(navigate).toHaveBeenCalledWith({ to: '/venue' });
    expect(screen.queryByText('Leave without booking in?')).not.toBeInTheDocument();
  });
});

describe('A-5: work survives a reload', () => {
  it('persists the working lines and restores them with a visible notice', async () => {
    const user = userEvent.setup();
    const first = renderScreen();
    await addIcing(user, 2);

    await waitFor(() => expect(localStorage.getItem(draftKey('goods-in', SITE.id))).not.toBeNull());

    // The reload.
    first.unmount();
    renderScreen();

    expect(await screen.findByText('Icing sugar')).toBeInTheDocument();
    expect(screen.getByText(/restored your unfinished delivery/i)).toBeInTheDocument();
  });

  it('a successful booking clears the draft — it is not unfinished any more', async () => {
    const user = userEvent.setup();
    renderScreen();
    await addIcing(user, 1);
    await waitFor(() => expect(localStorage.getItem(draftKey('goods-in', SITE.id))).not.toBeNull());

    await book(user);

    await waitFor(() => expect(localStorage.getItem(draftKey('goods-in', SITE.id))).toBeNull());
  });
});
