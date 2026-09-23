/**
 * Two counters, one take (Sept 2026) — the count screen, as a counter uses it.
 *
 * "Each user should see both the saved data that they have entered and that
 *  entered by other users - which user entered the other data should be shown"
 *
 * Covers: joining the venue's open count instead of starting a parallel one;
 * every saved count labelled with whose it is ("you" for your own); a save
 * refreshing the sheet with the others' counts; a warning before replacing a
 * number somebody else saved; and each save carrying its own idempotency key,
 * so a correction is never mistaken for a replay and dropped.
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

/** Sign this iPad in as Me, with a PIN token shaped like the real one. */
function signInAsMe() {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  const payload = { userId: 'pin:me', companyId: 'c', email: 'Me@pin.local', roles: ['head_baker'], label: 'Me' };
  localStorage.setItem('smmta_token', `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`);
}

const FLOUR = 'aaaaaaaa-0000-4000-8000-000000000001';
const SUGAR = 'aaaaaaaa-0000-4000-8000-000000000002';
const EGGS = 'aaaaaaaa-0000-4000-8000-000000000003';

const OPEN_TAKE = {
  id: 'take-9', scope: 'FULL', createdAt: '2026-09-23T08:40:00Z', openedByName: 'Sam',
  lineCount: 3, countedCount: 2, counters: ['Me', 'Sam'], lastCountedAt: '2026-09-23T09:42:00Z',
};

const line = (productId: string, name: string, over: Record<string, unknown> = {}) => ({
  productId, bookQty: '10', productName: name, stockCode: name.toUpperCase(), stockUom: 'kg',
  countedQty: null, countedByUserId: null, countedByName: null, countedAt: null, ...over,
});

/** The take as the server holds it: Sam counted flour, I counted sugar. */
let serverLines = () => [
  line(FLOUR, 'Flour', { countedQty: '12.000', countedByUserId: 'pin:sam', countedByName: 'Sam', countedAt: '2026-09-23T09:42:00Z' }),
  line(SUGAR, 'Sugar', { countedQty: '4.000', countedByUserId: 'pin:me', countedByName: 'Me', countedAt: '2026-09-23T09:40:00Z' }),
  line(EGGS, 'Eggs'),
];

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

function serveTake() {
  server.use(
    http.get(`${API}/stock-takes`, () => HttpResponse.json({ success: true, data: [OPEN_TAKE] })),
    http.get(`${API}/stock-takes/:id`, () =>
      HttpResponse.json({ success: true, data: { take: { id: 'take-9', scope: 'FULL' }, lines: serverLines(), warnings: [] } }),
    ),
    http.get(`${API}/products`, () =>
      HttpResponse.json({ success: true, data: [], total: 0, page: 1, pageSize: 250, totalPages: 1 }),
    ),
  );
}

/** Capture what the iPad sends when it saves. */
function captureSaves() {
  const bodies: Array<{ counts: Array<{ productId: string; countedQty: number; countIdempotencyKey: string }> }> = [];
  server.use(
    http.post(`${API}/stock-takes/:id/counts`, async ({ request }) => {
      bodies.push((await request.json()) as (typeof bodies)[number]);
      return HttpResponse.json({ success: true, data: { recorded: 1 } });
    }),
  );
  return bodies;
}

const rowFor = (name: string) => screen.getByText(name).closest('.row') as HTMLElement;

async function joinCount(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /join this count/i }));
  await screen.findByText('Flour');
}

beforeEach(() => {
  localStorage.clear();
  signInAsMe();
  serverLines = () => [
    line(FLOUR, 'Flour', { countedQty: '12.000', countedByUserId: 'pin:sam', countedByName: 'Sam', countedAt: '2026-09-23T09:42:00Z' }),
    line(SUGAR, 'Sugar', { countedQty: '4.000', countedByUserId: 'pin:me', countedByName: 'Me', countedAt: '2026-09-23T09:40:00Z' }),
    line(EGGS, 'Eggs'),
  ];
  serveTake();
});

describe('joining the count in progress', () => {
  it("offers the venue's open count, saying who started it and who is counting", async () => {
    renderScreen();
    const open = await screen.findByTestId('open-takes');
    expect(open).toHaveTextContent(/Full count · started \d\d:\d\d by Sam/);
    expect(open).toHaveTextContent('2 of 3 counted by Me, Sam');
    // Starting a separate count is still possible, but no longer the default.
    expect(screen.getByRole('button', { name: /start a new count/i })).toBeInTheDocument();
  });

  it('joining shows every saved count, including the ones this iPad never saw typed', async () => {
    const user = userEvent.setup();
    renderScreen();
    await joinCount(user);
    expect(within(rowFor('Flour')).getByRole('button', { name: /type quantity/i })).toHaveTextContent('12');
    expect(within(rowFor('Sugar')).getByRole('button', { name: /type quantity/i })).toHaveTextContent('4');
    expect(within(rowFor('Eggs')).getByRole('button', { name: /type quantity/i })).toHaveTextContent('—');
  });
});

describe('whose number is it', () => {
  it("names the other counter on their lines, and says 'you' on mine", async () => {
    const user = userEvent.setup();
    renderScreen();
    await joinCount(user);
    expect(within(rowFor('Flour')).getByText(/^Saved by Sam · \d\d:\d\d$/)).toBeInTheDocument();
    expect(within(rowFor('Sugar')).getByText(/^Saved by you · \d\d:\d\d$/)).toBeInTheDocument();
    expect(within(rowFor('Eggs')).queryByText(/saved by/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('shared-take-note')).toHaveTextContent(/Saved counts: Sam \(1\) · You \(1\)/);
  });

  it('a number typed here reads "Not saved yet" until it is saved', async () => {
    const user = userEvent.setup();
    renderScreen();
    await joinCount(user);
    await user.click(within(rowFor('Eggs')).getByRole('button', { name: /increase/i }));
    expect(within(rowFor('Eggs')).getByText('Not saved yet')).toBeInTheDocument();
  });

  it("after saving, the sheet re-reads the take and picks up the other counter's new counts", async () => {
    const user = userEvent.setup();
    const saves = captureSaves();
    renderScreen();
    await joinCount(user);
    await user.click(within(rowFor('Eggs')).getByRole('button', { name: /increase/i }));
    // Meanwhile, Sam's iPad saved... and the server now holds my eggs count too.
    serverLines = () => [
      line(FLOUR, 'Flour', { countedQty: '12.000', countedByUserId: 'pin:sam', countedByName: 'Sam', countedAt: '2026-09-23T09:42:00Z' }),
      line(SUGAR, 'Sugar', { countedQty: '5.000', countedByUserId: 'pin:sam', countedByName: 'Sam', countedAt: '2026-09-23T09:50:00Z' }),
      line(EGGS, 'Eggs', { countedQty: '1.000', countedByUserId: 'pin:me', countedByName: 'Me', countedAt: '2026-09-23T09:51:00Z' }),
    ];
    await user.click(screen.getByRole('button', { name: /save counts/i }));
    await waitFor(() => expect(saves).toHaveLength(1));
    await waitFor(() => expect(within(rowFor('Eggs')).getByText(/^Saved by you/)).toBeInTheDocument());
    expect(within(rowFor('Sugar')).getByText(/^Saved by Sam/)).toBeInTheDocument();
    expect(within(rowFor('Sugar')).getByRole('button', { name: /type quantity/i })).toHaveTextContent('5');
  });
});

describe("replacing someone else's count", () => {
  it('asks first, naming them and both numbers — and going back sends nothing', async () => {
    const user = userEvent.setup();
    const saves = captureSaves();
    renderScreen();
    await joinCount(user);
    await user.click(within(rowFor('Flour')).getByRole('button', { name: /decrease/i })); // 12 -> 11
    await user.click(screen.getByRole('button', { name: /save counts/i }));

    expect(await screen.findByText(/replace someone else's count\?/i)).toBeInTheDocument();
    expect(screen.getByText(/Sam counted 12 kg, you have 11 kg/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /go back and check/i }));
    expect(saves).toHaveLength(0);
    // Still on screen, still unsaved.
    expect(within(rowFor('Flour')).getByText('Not saved yet')).toBeInTheDocument();
  });

  it('"Replace with mine" saves it', async () => {
    const user = userEvent.setup();
    const saves = captureSaves();
    renderScreen();
    await joinCount(user);
    await user.click(within(rowFor('Flour')).getByRole('button', { name: /decrease/i }));
    await user.click(screen.getByRole('button', { name: /save counts/i }));
    await user.click(await screen.findByRole('button', { name: /replace with mine/i }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]!.counts).toEqual([expect.objectContaining({ productId: FLOUR, countedQty: 11 })]);
  });

  it('correcting my OWN saved count does not ask', async () => {
    const user = userEvent.setup();
    const saves = captureSaves();
    renderScreen();
    await joinCount(user);
    await user.click(within(rowFor('Sugar')).getByRole('button', { name: /increase/i }));
    await user.click(screen.getByRole('button', { name: /save counts/i }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(screen.queryByText(/replace someone else's count/i)).not.toBeInTheDocument();
  });
});

describe('a correction is never mistaken for a replay', () => {
  it('two saves of the same item carry different idempotency keys', async () => {
    // The key used to be take+product alone, so the server treated every later
    // save of an item as a replay of the first and silently kept the old
    // number. Offline replay stays safe because a queued save resends its own
    // body, key included.
    const user = userEvent.setup();
    const saves = captureSaves();
    renderScreen();
    await joinCount(user);
    await user.click(within(rowFor('Eggs')).getByRole('button', { name: /increase/i }));
    await user.click(screen.getByRole('button', { name: /save counts/i }));
    await waitFor(() => expect(saves).toHaveLength(1));
    await user.click(within(rowFor('Eggs')).getByRole('button', { name: /increase/i }));
    await user.click(screen.getByRole('button', { name: /save counts/i }));
    await waitFor(() => expect(saves).toHaveLength(2));
    const [k1, k2] = saves.map((b) => b.counts[0]!.countIdempotencyKey);
    expect(k1).toMatch(new RegExp(`^take-9:${EGGS}:`));
    expect(k1).not.toBe(k2);
  });
});
