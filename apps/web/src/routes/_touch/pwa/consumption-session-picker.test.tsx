/**
 * Choosing the session rather than typing its id (Sept-2026, item 8 follow-up).
 *
 * The Submit button reported as "not working at all" was disabled because the
 * Session ID was blank. That field was captioned "BumbleBee session id" — not
 * something anybody in a venue knows — so it got skipped. Making the refusal
 * explain itself fixed the symptom; offering the day's sittings removes the
 * question.
 *
 * ⚠️ THE PART THAT MATTERS MOST is the last describe block. BumbleBee session
 * polling is NOT wired in production, so the list is empty there today. A
 * picker that could only ever be empty would be a worse dead end than the box
 * it replaced — at least a baker could get past that one.
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
let submitted: { sessionId?: string } | null = null;

/** Two sittings on the same day — the case a bare uuid cannot tell apart. */
const EVENING = {
  sessionId: 'bb-evening-uuid',
  sessionDate: '2026-09-16',
  startsAt: '2026-09-16T18:30:00Z',
  covers: 24,
};
const MATINEE = {
  sessionId: 'bb-matinee-uuid',
  sessionDate: '2026-09-16',
  startsAt: '2026-09-16T11:00:00Z',
  covers: 12,
};

function stub(awaiting: { sessions: unknown[]; feedStatus: string } | 'error') {
  server.use(
    http.get(`${API}/session-consumption/awaiting`, () =>
      awaiting === 'error'
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json({ success: true, data: awaiting }),
    ),
    http.get(`${API}/recipes/bakes`, () =>
      HttpResponse.json({
        success: true,
        data: [{ bake: 'Battenburg', bakeType: 'REGULAR', isActive: true }],
      }),
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
      submitted = (await request.json()) as { sessionId?: string };
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

async function pickCakeAndBenches(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Battenburg' }));
  await user.click(screen.getByRole('button', { name: 'Number of Regular Benches' }));
  await user.click(screen.getByRole('button', { name: '5' }));
  await user.click(screen.getByRole('button', { name: /^save$/i }));
}

describe('the day’s sittings are offered', () => {
  it('labels each by time and guests, not by its BumbleBee id', async () => {
    // A bare uuid is not something a baker recognises. Two sittings on one day
    // would otherwise be two indistinguishable rows.
    stub({ sessions: [EVENING, MATINEE], feedStatus: 'live' });
    renderScreen();

    expect(await screen.findByRole('button', { name: /24 guests/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /12 guests/ })).toBeInTheDocument();
    expect(screen.queryByText('bb-evening-uuid')).toBeNull();
  });

  it('sends the id of the sitting that was tapped', async () => {
    const user = userEvent.setup();
    stub({ sessions: [EVENING, MATINEE], feedStatus: 'live' });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /12 guests/ }));
    await pickCakeAndBenches(user);
    await user.type(screen.getByLabelText(/your name/i), 'Sam');
    await user.click(screen.getByRole('button', { name: /load ingredients/i }));
    await screen.findByText('Caster Sugar');
    await user.click(screen.getByRole('button', { name: /submit consumption/i }));

    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted!.sessionId).toBe(MATINEE.sessionId);
  });

  it('confirms which sitting is being filed', async () => {
    const user = userEvent.setup();
    stub({ sessions: [EVENING], feedStatus: 'live' });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /24 guests/ }));
    expect(screen.getByText(/filing the .*24 guests.* session/i)).toBeInTheDocument();
  });

  it('will not load until a sitting is chosen', async () => {
    const user = userEvent.setup();
    stub({ sessions: [EVENING], feedStatus: 'live' });
    renderScreen();
    await pickCakeAndBenches(user);
    await user.type(screen.getByLabelText(/your name/i), 'Sam');

    const load = screen.getByRole('button', { name: /to continue/i });
    expect(load).toBeDisabled();
    expect(load).toHaveTextContent('Enter the session to continue');
  });
});

describe('⚠️ typing is always still reachable', () => {
  it('falls back to the field, and says WHY, when the feed is not connected', async () => {
    // This is the live state in production today. An empty picker with no
    // explanation would strand every baker.
    stub({ sessions: [], feedStatus: 'not_connected' });
    renderScreen();

    expect(
      await screen.findByText(/do not come across from BumbleBee yet, so type the session below/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/session id/i)).toBeInTheDocument();
  });

  it('says something different when the feed IS live but nothing is outstanding', async () => {
    stub({ sessions: [], feedStatus: 'live' });
    renderScreen();

    expect(
      await screen.findByText(/no sessions are outstanding for this venue and date/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/session id/i)).toBeInTheDocument();
  });

  it('falls back to the field when the lookup fails outright', async () => {
    // A venue iPad on bad wifi must not be blocked by a list it cannot fetch.
    stub('error');
    renderScreen();

    // The field is there IMMEDIATELY — it must not wait on the retry, because
    // the whole point is that a failed lookup never blocks the baker.
    expect(await screen.findByLabelText(/session id/i)).toBeInTheDocument();
    // The explanation follows once the one retry has been spent.
    expect(
      await screen.findByText(/could not reach the server/i, undefined, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  it('offers a way out even when sittings ARE listed', async () => {
    // A walk-in, or a sitting added after the poll. The list being non-empty
    // does not mean it is complete.
    const user = userEvent.setup();
    stub({ sessions: [EVENING], feedStatus: 'live' });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /isn’t listed/i }));
    const typed = screen.getByLabelText(/session id/i);
    await user.type(typed, 'WALK-IN-1');

    await pickCakeAndBenches(user);
    await user.type(screen.getByLabelText(/your name/i), 'Sam');
    await user.click(screen.getByRole('button', { name: /load ingredients/i }));
    await screen.findByText('Caster Sugar');
    await user.click(screen.getByRole('button', { name: /submit consumption/i }));

    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted!.sessionId).toBe('WALK-IN-1');
  });

  it('does not collapse the typed field out from under the baker', async () => {
    // Hiding it mid-type would discard what they had entered.
    const user = userEvent.setup();
    stub({ sessions: [EVENING], feedStatus: 'live' });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /isn’t listed/i }));
    await user.type(screen.getByLabelText(/session id/i), 'WALK');
    expect(screen.getByLabelText(/session id/i)).toHaveValue('WALK');
  });
});
