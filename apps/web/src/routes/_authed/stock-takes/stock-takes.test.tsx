/**
 * Stock-take results on the admin website (Oct 2026).
 *
 * "make it possible to see and download the stock count results from the app
 *  UI in a web browser"
 *
 * Covers: every venue's counts listed with progress and counters; empty
 * sheets hidden by default; the filters reaching the API; downloads (one
 * count, and every counted line of the filtered set); Cancel for managers
 * only; and one count line by line.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { tokenWithRoles } from '@/test/tokens';
import { StockTakesPage } from './index';
import { StockTakeDetailPage } from './$id';

const API = 'http://localhost:8080/api/v1';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({ component: null, useParams: () => ({ id: 'take-mcr' }) }),
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  };
});

const SITES = [
  { id: 'site-bham', name: 'Birmingham', isActive: true },
  { id: 'site-mcr', name: 'Manchester', isActive: true },
];
vi.mock('@/features/sites/site-context', () => ({
  useSiteContext: () => ({ sites: SITES, isLoading: false, selectedSiteId: null, selectedSite: null }),
  SiteProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const downloads: Array<{ path: string; searchParams?: Record<string, string> }> = [];
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/api-client');
  return {
    ...actual,
    apiFetchBlob: vi.fn(async (path: string, opts?: { searchParams?: Record<string, string> }) => {
      downloads.push({ path, searchParams: opts?.searchParams });
      return { blob: new Blob(['x']), filename: 'x.csv' };
    }),
    triggerBlobDownload: vi.fn(),
  };
});

const take = (over: Record<string, unknown>) => ({
  id: 'take-x', siteId: 'site-mcr', scope: 'FULL', status: 'OPEN', createdAt: '2026-10-02T13:53:00Z',
  approvedAt: null, openedByName: 'Jonas Gottschalk', lineCount: 640, countedCount: 291,
  counters: ['Jonas Gottschalk'], lastCountedAt: '2026-10-02T15:34:00Z', ...over,
});
const LIST = [
  take({ id: 'take-mcr' }),
  take({ id: 'take-empty', countedCount: 0, counters: [], openedByName: 'Amy Bank' }),
  take({ id: 'take-bham', siteId: 'site-bham', status: 'APPROVED', approvedAt: '2026-10-03T09:00:00Z', countedCount: 170, counters: ['Khushi Bhambri'] }),
];

let listQueries: URLSearchParams[] = [];
let cancelled: string[] = [];

function renderIt(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('smmta_token', tokenWithRoles(['site_manager']));
  downloads.length = 0;
  listQueries = [];
  cancelled = [];
  server.use(
    http.get(`${API}/stock-takes`, ({ request }) => {
      listQueries.push(new URL(request.url).searchParams);
      return HttpResponse.json({ success: true, data: LIST });
    }),
    http.post(`${API}/stock-takes/:id/cancel`, ({ params }) => {
      cancelled.push(params.id as string);
      return HttpResponse.json({ success: true, data: { id: params.id, status: 'CANCELLED' } });
    }),
    http.get(`${API}/stock-takes/:id`, () =>
      HttpResponse.json({
        success: true,
        data: {
          take: take({ id: 'take-mcr' }),
          lines: [
            { productId: 'p1', productName: 'Corona Extra Nrb', stockCode: 'BEER-CORO-EXTR', stockUom: 'bottle', itemCategoryName: 'Bar Stock', bookQty: '60', countedQty: '68', variance: '8', countedByName: 'Jonas Gottschalk', countedAt: '2026-10-02T15:07:00Z' },
            { productId: 'p2', productName: 'Aperol', stockCode: 'LIQR-APER-APRT', stockUom: 'bottle', itemCategoryName: 'Bar Stock', bookQty: '7.25', countedQty: '7.25', variance: '0', countedByName: 'Jonas Gottschalk', countedAt: '2026-10-02T15:07:00Z' },
            { productId: 'p3', productName: 'Caster Sugar', stockCode: 'BAKE-CAST-SUGR', stockUom: 'kg', itemCategoryName: 'Ingredients', bookQty: '20', countedQty: null, variance: null, countedByName: null, countedAt: null },
          ],
          warnings: [],
        },
      }),
    ),
  );
});

describe('Stock-takes list', () => {
  it("lists every venue's counts with progress and counters, hiding empty sheets by default", async () => {
    const user = userEvent.setup();
    renderIt(<StockTakesPage />);
    const table = await screen.findByTestId('stock-take-table');
    expect(table).toHaveTextContent('Manchester');
    expect(table).toHaveTextContent('291 of 640');
    expect(table).toHaveTextContent('Birmingham');
    expect(table).toHaveTextContent('Khushi Bhambri');
    expect(table).not.toHaveTextContent('Amy Bank');
    await user.click(screen.getByLabelText(/hide counts with nothing counted/i));
    expect(screen.getByTestId('stock-take-table')).toHaveTextContent('Amy Bank');
  });

  it('sends the venue, status and dates to the API', async () => {
    const user = userEvent.setup();
    renderIt(<StockTakesPage />);
    await screen.findByTestId('stock-take-table');
    expect(listQueries[0]!.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await user.selectOptions(screen.getByLabelText('Venue'), 'site-mcr');
    await user.selectOptions(screen.getByLabelText('Status'), 'APPROVED');
    await waitFor(() => {
      const last = listQueries[listQueries.length - 1]!;
      expect([last.get('siteId'), last.get('status')]).toEqual(['site-mcr', 'APPROVED']);
    });
  });

  it('downloads one count, and every counted line of the filtered counts', async () => {
    const user = userEvent.setup();
    renderIt(<StockTakesPage />);
    const table = await screen.findByTestId('stock-take-table');
    await user.click(within(table).getAllByRole('button', { name: /download manchester count/i })[0]!);
    await user.click(screen.getByRole('button', { name: /download all counted lines/i }));
    await waitFor(() => expect(downloads).toHaveLength(2));
    expect(downloads[0]!.path).toBe('/stock-takes/take-mcr/export.csv');
    expect(downloads[1]!.path).toBe('/stock-takes/export.csv');
    expect(downloads[1]!.searchParams!.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a manager can cancel an open count, after confirming; approved ones offer no Cancel', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderIt(<StockTakesPage />);
    const table = await screen.findByTestId('stock-take-table');
    expect(within(table).getAllByRole('button', { name: 'Cancel' })).toHaveLength(1); // the open Manchester one
    await user.click(within(table).getByRole('button', { name: 'Cancel' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/291 counted lines are kept/));
    await waitFor(() => expect(cancelled).toEqual(['take-mcr']));
  });

  it('a head baker sees the counts but no Cancel', async () => {
    localStorage.setItem('smmta_token', tokenWithRoles(['head_baker']));
    renderIt(<StockTakesPage />);
    const table = await screen.findByTestId('stock-take-table');
    expect(within(table).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });
});

describe('one count, line by line', () => {
  it('shows counted lines with book, counted, variance and who — then the rest on request', async () => {
    const user = userEvent.setup();
    renderIt(<StockTakeDetailPage id="take-mcr" />);
    const lines = await screen.findByTestId('take-lines');
    expect(screen.getByTestId('take-summary')).toHaveTextContent('2 of 3 counted by Jonas Gottschalk · 1 differ from book');
    const corona = within(lines).getByText('Corona Extra Nrb').closest('tr')!;
    expect(corona).toHaveTextContent('bottle6068+8Jonas Gottschalk');
    expect(within(lines).queryByText('Caster Sugar')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /not counted \(1\)/i }));
    expect(within(screen.getByTestId('take-lines')).getByText('Caster Sugar')).toBeInTheDocument();
  });

  it('downloads it, and a manager can cancel it while it is open', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderIt(<StockTakeDetailPage id="take-mcr" />);
    await screen.findByTestId('take-lines');
    await user.click(screen.getByRole('button', { name: /download spreadsheet/i }));
    await waitFor(() => expect(downloads.map((d) => d.path)).toEqual(['/stock-takes/take-mcr/export.csv']));
    await user.click(screen.getByRole('button', { name: /cancel this count/i }));
    await waitFor(() => expect(cancelled).toEqual(['take-mcr']));
  });
});
