/**
 * Per-diet sections and per-part lines on the bake form (Sept-2026, items 5, 6).
 *
 * "When there are items on the vegan or GF recipe that are the same as those on
 *  the regular recipe, we currently combine them onto one line in the end of
 *  bake form, users found this confusing so please split the different recipe
 *  sections into separate sections with headers. Even though this will result
 *  in multiple lines for the same product."
 *
 * The thing that breaks quietly if this is wrong is the React key. Two lines
 * for the same product used to be impossible; keyed on `productId` they would
 * now share an identity, and editing one would move the other.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { ToastContextProvider } from '@/hooks/use-toast';
import { tokenWithRoles } from '@/test/tokens';
import { ConsumptionScreen } from './consumption';

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

const FLOUR = '11111111-1111-4111-8111-111111111111';
const ICING = '22222222-2222-4222-8222-222222222222';

const line = (over: Record<string, unknown>) => ({
  productId: FLOUR,
  productName: 'Plain flour',
  qtyPerCover: 100,
  expectedQty: 300,
  stockUom: 'g',
  unitCost: null,
  expectedCost: null,
  section: 'REGULAR',
  benches: 3,
  component: '',
  ...over,
});

let submitted: { lines?: Array<Record<string, unknown>> } | null = null;

function stub(lines: unknown[]) {
  server.use(
    http.get(`${API}/recipes/bakes`, () =>
      HttpResponse.json({
        success: true,
        data: [{ bake: 'Battenburg', bakeType: 'REGULAR', isActive: true }],
      }),
    ),
    http.get(`${API}/recipes/coverage`, () =>
      HttpResponse.json({ success: true, data: { hasRecipe: true, glutenFree: true, vegan: true } }),
    ),
    http.post(`${API}/recipes/expected`, () =>
      HttpResponse.json({ success: true, data: { lines, blockers: [] } }),
    ),
    http.post(`${API}/session-consumption`, async ({ request }) => {
      submitted = (await request.json()) as { lines?: Array<Record<string, unknown>> };
      return HttpResponse.json({ success: true, data: { id: 'rec-1' } });
    }),
  );
}

beforeEach(() => {
  submitted = null;
  localStorage.clear();
  localStorage.setItem('smmta_token', tokenWithRoles(['head_baker'], SITE.id));
});

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ToastContextProvider>
        <ConsumptionScreen />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
}

async function load(user: ReturnType<typeof userEvent.setup>, vegan = 0) {
  await user.click(await screen.findByRole('button', { name: 'Battenburg' }));
  await user.click(screen.getByRole('button', { name: 'Number of Regular Benches' }));
  await user.click(screen.getByRole('button', { name: '3' }));
  await user.click(screen.getByRole('button', { name: /^save$/i }));
  if (vegan > 0) {
    await user.click(screen.getByRole('button', { name: 'Number of Vegan Benches' }));
    await user.click(screen.getByRole('button', { name: String(vegan) }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
  }
  await user.type(screen.getByLabelText(/session id/i), 'BB-1');
  await user.type(screen.getByLabelText(/your name/i), 'Sam');
  await user.click(screen.getByRole('button', { name: /load ingredients/i }));
}

describe('item 5: diet sections', () => {
  it('heads each section and names the benches it covers', async () => {
    const user = userEvent.setup();
    stub([
      line({}),
      line({ section: 'VEGAN', benches: 2, expectedQty: 200 }),
    ]);
    renderScreen();
    await load(user, 2);

    const heads = await screen.findAllByRole('heading', { level: 2 });
    expect(heads.map((h) => h.textContent)).toEqual([
      'Regular · 3 benches',
      'Vegan · 2 benches',
    ]);
  });

  it('shows the SAME ingredient once per section, each editable on its own', async () => {
    // Keyed on productId these two rows would share an identity, and typing
    // into one would move the other. That is the failure this guards.
    const user = userEvent.setup();
    stub([
      line({}),
      line({ section: 'VEGAN', benches: 2, expectedQty: 200 }),
    ]);
    renderScreen();
    await load(user, 2);

    const rows = await screen.findAllByText('Plain flour');
    expect(rows).toHaveLength(2);

    const values = screen.getAllByRole('button', { name: /Type amount of Plain flour used/i });
    expect(values.map((v) => v.textContent)).toEqual(['300', '200']);

    // Move the regular row only.
    await user.click(screen.getAllByRole('button', { name: /Increase Plain flour/i })[0]!);
    const after = screen.getAllByRole('button', { name: /Type amount of Plain flour used/i });
    expect(after.map((v) => v.textContent)).toEqual(['301', '200']);
  });

  it('counts benches against the SECTION, not the whole session', async () => {
    const user = userEvent.setup();
    stub([line({}), line({ section: 'VEGAN', benches: 2, expectedQty: 200 })]);
    renderScreen();
    await load(user, 2);

    await screen.findAllByText('Plain flour');
    // 300 g at 100 g per bench is 3 of the regular section's 3 benches — not
    // "3 of 5", which is what counting against the whole session gave.
    expect(screen.getByText('3 of 3 benches')).toBeInTheDocument();
    expect(screen.getByText('2 of 2 benches')).toBeInTheDocument();
  });

  it('drops the heading when there is only one section', async () => {
    // A lone "Regular" header above every ingredient is noise.
    const user = userEvent.setup();
    stub([line({})]);
    renderScreen();
    await load(user);

    await screen.findByText('Plain flour');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('sends the section on every line, so the server can tell them apart', async () => {
    const user = userEvent.setup();
    stub([line({}), line({ section: 'VEGAN', benches: 2, expectedQty: 200 })]);
    renderScreen();
    await load(user, 2);
    await screen.findAllByText('Plain flour');

    await user.click(screen.getByRole('button', { name: /submit consumption/i }));
    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted!.lines!.map((l) => l.section)).toEqual(['REGULAR', 'VEGAN']);
  });
});

describe('item 6: one ingredient, several parts of the cake', () => {
  it('labels each line with its part so the two are told apart by reading', async () => {
    const user = userEvent.setup();
    stub([
      line({ productId: ICING, productName: 'Icing sugar', component: 'Cake', expectedQty: 60 }),
      line({ productId: ICING, productName: 'Icing sugar', component: 'Topping', expectedQty: 225 }),
    ]);
    renderScreen();
    await load(user);

    const names = await screen.findAllByText('Icing sugar');
    expect(names).toHaveLength(2);
    expect(within(names[0]!).getByText('Cake')).toBeInTheDocument();
    expect(within(names[1]!).getByText('Topping')).toBeInTheDocument();
  });

  it('sends the component with each line', async () => {
    const user = userEvent.setup();
    stub([
      line({ productId: ICING, productName: 'Icing sugar', component: 'Cake', expectedQty: 60 }),
      line({ productId: ICING, productName: 'Icing sugar', component: 'Topping', expectedQty: 225 }),
    ]);
    renderScreen();
    await load(user);
    await screen.findAllByText('Icing sugar');

    await user.click(screen.getByRole('button', { name: /submit consumption/i }));
    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted!.lines!.map((l) => l.component)).toEqual(['Cake', 'Topping']);
  });
});
