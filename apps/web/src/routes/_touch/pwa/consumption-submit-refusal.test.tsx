/**
 * Item 8 (Sept-2026): "The submit consumption button at the end of bake form
 * it's not working at all. Investigate and fix."
 *
 * It was `disabled`, because `canSubmit` required a Session ID and a baker
 * name. Neither was required to LOAD the ingredients, so the journey below was
 * possible: pick the cake, type the benches, skip the two text boxes below the
 * fold, load twenty ingredients, count every one of them, press Submit —
 * nothing. The label still read "Submit consumption" and no message appeared.
 *
 * "Session ID" is the one that got skipped. It was captioned "BumbleBee
 * session id", which is not something a head baker carries in their head.
 *
 * These tests walk that exact journey and assert that it is now impossible to
 * reach the ingredients screen in an unsubmittable state, and that every
 * refusal says what it wants.
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

const PRODUCT = '11111111-1111-4111-8111-111111111111';

let submitted: unknown = null;

beforeEach(() => {
  submitted = null;
  localStorage.clear();
  localStorage.setItem('smmta_token', tokenWithRoles(['head_baker'], SITE.id));
  server.use(
    http.get(`${API}/recipes/bakes`, () =>
      HttpResponse.json({ success: true, data: [{ bake: 'Battenburg', bakeType: 'REGULAR', isActive: true }] }),
    ),
    http.get(`${API}/recipes/coverage`, () =>
      HttpResponse.json({ success: true, data: { hasRecipe: true, glutenFree: false, vegan: false } }),
    ),
    http.post(`${API}/recipes/expected`, () =>
      HttpResponse.json({
        success: true,
        data: {
          lines: [
            {
              productId: PRODUCT,
              productName: 'Caster Sugar',
              qtyPerCover: 100,
              expectedQty: 500,
              stockUom: 'g',
              unitCost: null,
              expectedCost: null,
              section: 'REGULAR',
              benches: 5,
              component: '',
            },
          ],
          blockers: [],
        },
      }),
    ),
    http.post(`${API}/session-consumption`, async ({ request }) => {
      submitted = await request.json();
      return HttpResponse.json({ success: true, data: { id: 'rec-1' } });
    }),
  );
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

/** Pick the cake and the bench count — and nothing else. */
async function pickCakeAndBenches(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Battenburg' }));
  await user.click(screen.getByRole('button', { name: 'Number of Regular Benches' }));
  await user.click(screen.getByRole('button', { name: '5' }));
  await user.click(screen.getByRole('button', { name: /^save$/i }));
}

describe('item 8: the dead Submit button', () => {
  it('will not load the ingredients while the session id is blank — and says so', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickCakeAndBenches(user);

    // This is the journey that used to succeed, stranding the baker on a
    // screen whose Submit could never fire.
    const load = screen.getByRole('button', { name: /to continue|load ingredients/i });
    expect(load).toBeDisabled();
    expect(load).toHaveTextContent('Enter the session to continue');
    // And the OTHER outstanding answer is named too, rather than revealed one
    // press at a time.
    expect(screen.getByRole('status')).toHaveTextContent('Also needed: your name');
  });

  it('loads once the session and the baker are given', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickCakeAndBenches(user);
    await user.type(screen.getByLabelText(/session id/i), 'BB-12345');
    await user.type(screen.getByLabelText(/your name/i), 'Sam');

    const load = screen.getByRole('button', { name: /load ingredients/i });
    expect(load).toBeEnabled();
    await user.click(load);

    expect(await screen.findByText('Caster Sugar')).toBeInTheDocument();
  });

  it('submits — the press that used to do nothing', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickCakeAndBenches(user);
    await user.type(screen.getByLabelText(/session id/i), 'BB-12345');
    await user.type(screen.getByLabelText(/your name/i), 'Sam');
    await user.click(screen.getByRole('button', { name: /load ingredients/i }));
    await screen.findByText('Caster Sugar');

    const submit = screen.getByRole('button', { name: /submit consumption/i });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted).toMatchObject({
      sessionId: 'BB-12345',
      bakerName: 'Sam',
      siteId: SITE.id,
      bake: 'Battenburg',
    });
  });

  it('names the uncounted lines rather than sitting dead (F-8 still holds)', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickCakeAndBenches(user);
    await user.type(screen.getByLabelText(/session id/i), 'BB-12345');
    await user.type(screen.getByLabelText(/your name/i), 'Sam');
    await user.click(screen.getByRole('button', { name: /load ingredients/i }));
    await screen.findByText('Caster Sugar');

    // Switch the line to "what's left" without answering it.
    await user.click(screen.getByRole('button', { name: /entering: amount used/i }));

    const submit = screen.getByRole('button', { name: /to continue/i });
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent('Enter what is left of 1 ingredient to continue');
  });
});

describe('item 2: the cake picker is grouped', () => {
  it('renders a heading per group, in the fixed order', async () => {
    server.use(
      http.get(`${API}/recipes/bakes`, () =>
        HttpResponse.json({
          success: true,
          data: [
            { bake: 'Away Day Bake', bakeType: 'CORPORATE', isActive: true },
            { bake: 'Battenburg', bakeType: 'REGULAR', isActive: true },
            { bake: 'Staff Experiment', bakeType: 'OTHER', isActive: true },
          ],
        }),
      ),
    );
    renderScreen();

    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['Corporate', 'Regular', 'Other']);
  });

  it('says so when the venue has no active cakes, rather than showing a blank', async () => {
    // An empty picker with no explanation is the F-6 failure mode again:
    // nothing on screen, and nothing saying why.
    server.use(
      http.get(`${API}/recipes/bakes`, () => HttpResponse.json({ success: true, data: [] })),
    );
    renderScreen();

    expect(await screen.findByText(/no active cakes for this venue/i)).toBeInTheDocument();
  });
});

describe('item 4: the bench controls are the louder half of the row', () => {
  it('splits the row into a gram editor and a bench zone, and colours the direction', async () => {
    // "the 'bench + and - buttons' … are more important to them than the
    // number of grams". Structure, not cosmetics: the two zones are what the
    // 20% scale and the red/green are applied to.
    const user = userEvent.setup();
    renderScreen();
    await pickCakeAndBenches(user);
    await user.type(screen.getByLabelText(/session id/i), 'BB-12345');
    await user.type(screen.getByLabelText(/your name/i), 'Sam');
    await user.click(screen.getByRole('button', { name: /load ingredients/i }));
    await screen.findByText('Caster Sugar');

    const down = screen.getByRole('button', { name: /remove one bench of Caster Sugar/i });
    const up = screen.getByRole('button', { name: /add one bench of Caster Sugar/i });
    expect(down).toHaveClass('bench-down');
    expect(up).toHaveClass('bench-up');
    // Both sit in the bench zone, and the gram steppers do not.
    expect(down.closest('.bench-controls')).not.toBeNull();
    expect(up.closest('.bench-controls')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: /increase Caster Sugar/i }).closest('.qty-edit'),
    ).not.toBeNull();
  });
});
