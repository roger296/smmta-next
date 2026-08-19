/**
 * The End of Bake screen must refuse loudly (Aug-2026, F-5 / F-6).
 *
 * "No bake logs were submitted due to incorrect recipe data."
 * "Selecting Vegan or GF options for Battenburg failed to generate required
 *  ingredients."
 *
 * Both defects presented the same way — as *nothing happening*. A transient
 * toast over an empty ingredient list reads as "there is nothing to record
 * today", so an evening's bakes went unrecorded and nobody escalated.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

interface Coverage {
  hasRecipe: boolean;
  glutenFree: boolean;
  vegan: boolean;
}

function stub(opts: {
  coverage: Coverage;
  lines?: unknown[];
  blockers?: Array<{ kind: string; message: string }>;
}) {
  server.use(
    http.get(`${API}/recipes/bakes`, () =>
      HttpResponse.json({ success: true, data: ['Battenburg'] }),
    ),
    http.get(`${API}/recipes/coverage`, () =>
      HttpResponse.json({ success: true, data: opts.coverage }),
    ),
    http.post(`${API}/recipes/expected`, () =>
      HttpResponse.json({
        success: true,
        data: { lines: opts.lines ?? [], blockers: opts.blockers ?? [] },
      }),
    ),
  );
}

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

/** Pick the cake and type a regular table count, then load. */
async function setUp(user: ReturnType<typeof userEvent.setup>, tables = 5) {
  await user.click(await screen.findByRole('button', { name: 'Battenburg' }));
  await user.click(screen.getByRole('button', { name: /number of regular tables/i }));
  await user.click(screen.getByRole('button', { name: String(tables) }));
  await user.click(screen.getByRole('button', { name: /^save$/i }));
  await user.click(screen.getByRole('button', { name: /load ingredients/i }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('smmta_token', tokenWithRoles(['head_baker'], SITE.id));
});

describe('F-6: a missing recipe is a refusal, not an empty list', () => {
  it('shows a blocking notice naming the cake, the date and the venue', async () => {
    const user = userEvent.setup();
    stub({
      coverage: { hasRecipe: false, glutenFree: false, vegan: false },
      blockers: [
        {
          kind: 'NO_RECIPE',
          message: 'No recipe for "Battenburg" on 2026-08-19 at this site.',
        },
      ],
    });
    renderScreen();
    await setUp(user);

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent(/This bake cannot be recorded/i);
    expect(notice).toHaveTextContent('Battenburg');
    expect(notice).toHaveTextContent(SITE.name);
    expect(notice).toHaveTextContent(/No recipe for "Battenburg"/);
    // The explicit verdict — the whole point of F-6.
    expect(notice).toHaveTextContent(/This bake cannot be submitted\./);
  });

  it('stays on the setup screen — it never advances into an empty ingredient list', async () => {
    const user = userEvent.setup();
    stub({
      coverage: { hasRecipe: false, glutenFree: false, vegan: false },
      blockers: [{ kind: 'NO_RECIPE', message: 'No recipe.' }],
    });
    renderScreen();
    await setUp(user);

    await screen.findByRole('alert');
    // The ingredients screen's submit button must not exist.
    expect(screen.queryByRole('button', { name: /submit consumption/i })).toBeNull();
    // The setup control is still there to correct.
    expect(screen.getByRole('button', { name: /load ingredients/i })).toBeTruthy();
  });

  it('the refusal cannot be dismissed back to a silent empty form', async () => {
    const user = userEvent.setup();
    stub({
      coverage: { hasRecipe: false, glutenFree: false, vegan: false },
      blockers: [{ kind: 'NO_RECIPE', message: 'No recipe.' }],
    });
    renderScreen();
    await setUp(user);

    const notice = await screen.findByRole('alert');
    expect(notice.querySelector('.notice-dismiss')).toBeNull();
  });

  it('loads normally when there are no blockers', async () => {
    const user = userEvent.setup();
    stub({
      coverage: { hasRecipe: true, glutenFree: true, vegan: true },
      lines: [
        {
          productId: 'p1',
          productName: 'Plain Flour',
          qtyPerCover: 400,
          expectedQty: 2000,
          stockUom: 'g',
          unitCost: null,
          expectedCost: null,
        },
      ],
    });
    renderScreen();
    await setUp(user);

    expect(await screen.findByText('Plain Flour')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('F-5: a diet the cake has no recipe for is refused up front', () => {
  it('disables the gluten-free field and says to ask head office', async () => {
    const user = userEvent.setup();
    stub({ coverage: { hasRecipe: true, glutenFree: false, vegan: true } });
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Battenburg' }));

    await waitFor(() =>
      expect(
        screen.getByText(/no gluten-free recipe for this cake — ask head office/i),
      ).toBeTruthy(),
    );
    const gf = screen.getByRole('button', { name: /number of gluten free tables/i });
    expect(gf).toBeDisabled();
    // The vegan side, which the cake DOES have, stays usable.
    expect(screen.getByRole('button', { name: /number of vegan tables/i })).not.toBeDisabled();
    expect(screen.queryByText(/no vegan recipe for this cake/i)).toBeNull();
  });

  it('disables the vegan field when the cake has no vegan variant', async () => {
    const user = userEvent.setup();
    stub({ coverage: { hasRecipe: true, glutenFree: true, vegan: false } });
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Battenburg' }));

    await waitFor(() =>
      expect(screen.getByText(/no vegan recipe for this cake — ask head office/i)).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /number of vegan tables/i })).toBeDisabled();
  });

  it('surfaces the server-side variant blocker as the same blocking notice', async () => {
    const user = userEvent.setup();
    stub({
      coverage: { hasRecipe: true, glutenFree: true, vegan: true },
      blockers: [
        {
          kind: 'NO_GF_VARIANT',
          message: '"Battenburg" has no gluten-free recipe, so 2 gluten-free table(s) would silently get the standard ingredients.',
        },
      ],
    });
    renderScreen();
    await setUp(user);

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent(/silently get the standard ingredients/);
    expect(notice).toHaveTextContent(/This bake cannot be submitted\./);
  });
});
