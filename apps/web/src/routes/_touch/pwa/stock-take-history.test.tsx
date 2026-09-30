/**
 * Seeing what was counted (30 Sept 2026).
 *
 * "how can i see what has been counted in the stocktake today?" — once a count
 * was approved it vanished: the start screen listed open counts only, and
 * there was no other screen. Covers: approved counts listed under Recent
 * counts; View opening one read-only (numbers, book figures, no controls, no
 * Save/Approve); the Counted chip; and the spreadsheet download.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

const SITE = { id: 'site-1', name: 'Manchester', isActive: true };
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

const downloads: string[] = [];
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/api-client');
  return {
    ...actual,
    apiFetchBlob: vi.fn(async (path: string) => {
      downloads.push(path);
      return { blob: new Blob(['x']), filename: 'stock-take-manchester-2026-09-30.csv' };
    }),
    triggerBlobDownload: vi.fn(),
  };
});

function signInAsManager() {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  const payload = { userId: 'pin:jo', companyId: 'c', email: 'Jo@pin.local', roles: ['site_manager'], label: 'Jo' };
  localStorage.setItem('smmta_token', `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`);
}

const FLOUR = 'aaaaaaaa-0000-4000-8000-000000000001';
const CRUMBLE = 'aaaaaaaa-0000-4000-8000-000000000002';

const APPROVED = {
  id: 'take-done', scope: 'FULL', status: 'APPROVED', createdAt: '2026-09-30T08:40:00Z',
  approvedAt: '2026-09-30T13:05:00Z', openedByName: 'Jonas', lineCount: 2, countedCount: 1,
  counters: ['Jonas'], lastCountedAt: '2026-09-30T12:00:00Z',
};

const line = (productId: string, name: string, over: Record<string, unknown> = {}) => ({
  productId, bookQty: '6', productName: name, stockCode: name.toUpperCase(), stockUom: 'bottle',
  countedQty: null, countedByUserId: null, countedByName: null, countedAt: null, variance: null, ...over,
});

function serve(listed: unknown[]) {
  server.use(
    http.get(`${API}/stock-takes`, ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      // The open list asks for OPEN; the recent list asks for everything.
      const data = status ? listed.filter((t) => (t as { status: string }).status === status) : listed;
      return HttpResponse.json({ success: true, data });
    }),
    http.get(`${API}/stock-takes/:id`, () =>
      HttpResponse.json({
        success: true,
        data: {
          take: { id: 'take-done', scope: 'FULL', status: 'APPROVED', approvedAt: APPROVED.approvedAt },
          lines: [
            line(FLOUR, 'Cocktail Flour', {
              countedQty: '4.000', variance: '-2.000', countedByUserId: 'pin:jonas', countedByName: 'Jonas',
              countedAt: '2026-09-30T12:00:00Z',
            }),
            line(CRUMBLE, 'Summer Crumble Mix', { bookQty: '0' }),
          ],
          warnings: [],
        },
      }),
    ),
    http.get(`${API}/products`, () =>
      HttpResponse.json({ success: true, data: [], total: 0, page: 1, pageSize: 250, totalPages: 1 }),
    ),
  );
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

beforeEach(() => {
  localStorage.clear();
  signInAsManager();
  downloads.length = 0;
  serve([APPROVED]);
});

describe('seeing what was counted', () => {
  it('an approved count is listed under Recent counts, with its progress and counters', async () => {
    renderScreen();
    const recent = await screen.findByTestId('recent-takes');
    expect(recent).toHaveTextContent('Full count · approved');
    expect(recent).toHaveTextContent('1 of 2 counted by Jonas');
    // It is finished, so it is not offered to join.
    expect(screen.queryByRole('button', { name: /join this count/i })).not.toBeInTheDocument();
  });

  it('View opens it read-only: numbers and book figures, no controls, no Save or Approve', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(within(await screen.findByTestId('recent-takes')).getByRole('button', { name: 'View' }));
    const row = (await screen.findByText('Cocktail Flour')).closest('.row') as HTMLElement;
    expect(within(row).getByLabelText('Counted quantity')).toHaveTextContent('4');
    expect(row).toHaveTextContent('book 6 bottle');
    expect(row).toHaveTextContent('Jonas');
    expect(within(row).queryByRole('button', { name: /increase/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save counts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('shared-take-note')).toHaveTextContent(/Approved .* read only/);
  });

  it('the Counted chip shows only what was counted', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(within(await screen.findByTestId('recent-takes')).getByRole('button', { name: 'View' }));
    await screen.findByText('Summer Crumble Mix');
    await user.click(screen.getByRole('button', { name: 'Counted' }));
    expect(screen.getByText('Cocktail Flour')).toBeInTheDocument();
    expect(screen.queryByText('Summer Crumble Mix')).not.toBeInTheDocument();
  });

  it('Download fetches the spreadsheet for that count — from the list and from the view', async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(within(await screen.findByTestId('recent-takes')).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(downloads).toEqual(['/stock-takes/take-done/export.csv']));
    await user.click(within(screen.getByTestId('recent-takes')).getByRole('button', { name: 'View' }));
    await screen.findByText('Cocktail Flour');
    await user.click(screen.getByRole('button', { name: 'Download spreadsheet' }));
    await waitFor(() => expect(downloads).toHaveLength(2));
  });

  it('an open count is offered to join, not listed as recent', async () => {
    serve([{ ...APPROVED, id: 'take-open', status: 'OPEN', approvedAt: null }]);
    renderScreen();
    await screen.findByRole('button', { name: /join this count/i });
    expect(screen.queryByTestId('recent-takes')).not.toBeInTheDocument();
  });
});
