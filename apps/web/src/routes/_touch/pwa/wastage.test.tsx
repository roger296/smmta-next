/**
 * The Wastage screen (Sept-2026 user testing, item 7).
 *
 * "take this wastage function out of the end of bake form and create a separate
 *  Wastage form linked to by a new main menu item on the PWA where any items
 *  from stock can be marked as wasted."
 *
 * The point of the move is what it unlocks: any stocked item, at any time, by
 * anyone with a PIN — not just an ingredient a recipe expected, during a bake,
 * by whoever was filing it.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { ToastContextProvider } from '@/hooks/use-toast';
import { tokenWithRoles } from '@/test/tokens';
import { WastageScreen } from './wastage';

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

const EGGS = {
  id: 'prod-eggs',
  name: 'Free range eggs',
  stockCode: 'EGG-01',
  stockUom: 'each',
};

let posted: Record<string, unknown> | null = null;

beforeEach(() => {
  posted = null;
  localStorage.clear();
  localStorage.setItem('smmta_token', tokenWithRoles(['head_baker'], SITE.id));
  server.use(
    http.get(`${API}/products`, () =>
      HttpResponse.json({ success: true, data: [EGGS], totalPages: 1 }),
    ),
    http.get(`${API}/wastage`, () => HttpResponse.json({ success: true, data: [] })),
    http.post(`${API}/wastage`, async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ success: true, data: { id: 'w-1' } }, { status: 201 });
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
        <WastageScreen />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
}

async function pickEggs(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText(/search or scan an item/i), 'eggs');
  await user.click(await screen.findByText('Free range eggs'));
}

describe('recording wastage', () => {
  it('records any stocked item — not just something a recipe expected', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickEggs(user);

    await user.click(screen.getByRole('button', { name: /how much was wasted/i }));
    await user.click(screen.getByRole('button', { name: '3' }));
    await user.click(screen.getByRole('button', { name: '0' }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await user.click(screen.getByRole('button', { name: 'Dropped' }));

    await user.click(screen.getByRole('button', { name: /record wastage/i }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({
      siteId: SITE.id,
      productId: EGGS.id,
      qty: 30,
      reason: 'Dropped',
    });
    // No bake — the commonest case, and the one the old triangle could not
    // express at all.
    expect(posted!.sessionId).toBeNull();
  });

  it('carries an idempotency key, so a retry cannot waste the stock twice', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickEggs(user);
    await user.click(screen.getByRole('button', { name: /how much was wasted/i }));
    await user.click(screen.getByRole('button', { name: '5' }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await user.click(screen.getByRole('button', { name: 'Spillage' }));
    await user.click(screen.getByRole('button', { name: /record wastage/i }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(String(posted!.clientKey)).toMatch(/^wastage:/);
  });

  it('refuses without a reason, and says which answer is missing', async () => {
    // Wastage with no reason cannot be told from a counting error.
    const user = userEvent.setup();
    renderScreen();
    await pickEggs(user);
    await user.click(screen.getByRole('button', { name: /how much was wasted/i }));
    await user.click(screen.getByRole('button', { name: '5' }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const submit = screen.getByRole('button', { name: /to continue/i });
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent('Enter a reason to continue');
  });

  it('refuses without a quantity', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickEggs(user);
    await user.click(screen.getByRole('button', { name: 'Burnt' }));

    const submit = screen.getByRole('button', { name: /to continue/i });
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent('Enter a quantity to continue');
  });

  it('accepts a typed reason as well as the chips', async () => {
    // The chip list is a keyboard shortcut, not a taxonomy — a reason nobody
    // can express is worse than one nobody has counted yet.
    const user = userEvent.setup();
    renderScreen();
    await pickEggs(user);
    await user.click(screen.getByRole('button', { name: /how much was wasted/i }));
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await user.type(screen.getByLabelText(/^reason$/i), 'Fridge failure overnight');

    await user.click(screen.getByRole('button', { name: /record wastage/i }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.reason).toBe('Fridge failure overnight');
  });
});
