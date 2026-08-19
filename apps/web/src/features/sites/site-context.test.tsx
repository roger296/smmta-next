/**
 * Site precedence (Aug-2026 feedback set, defect E-1).
 *
 * "Accidental booking logged 100kg to Birmingham."
 *
 * `POST /auth/pin-login` returns the site the PIN is scoped to and embeds it in
 * the JWT; the PIN screen read only the token and threw the rest away. This
 * provider then fell through to "first active site by name" — Birmingham, of
 * the five seeded sites. These specs pin the order, with a fixture deliberately
 * shaped like the real one: Birmingham first alphabetically, the device bound
 * to London South.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { SiteProvider, useSiteContext } from './site-context';
import { setDeviceSite, clearDeviceSite } from './device-site';

const API = 'http://localhost:8080/api/v1';

const BIRMINGHAM = { id: 'site-birmingham', slug: 'birmingham', name: 'Birmingham', isActive: true };
const LONDON_SOUTH = { id: 'site-london-south', slug: 'london-south', name: 'London South', isActive: true };
const MANCHESTER = { id: 'site-manchester', slug: 'manchester', name: 'Manchester', isActive: true };

/** Alphabetical, exactly as `asc(sites.name)` returns them. */
const SITES = [BIRMINGHAM, LONDON_SOUTH, MANCHESTER];

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <SiteProvider>{children}</SiteProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  clearDeviceSite();
  server.use(http.get(`${API}/sites`, () => HttpResponse.json({ success: true, data: SITES })));
});

afterEach(() => vi.restoreAllMocks());

describe('SiteProvider precedence (E-1)', () => {
  it('E-1 REGRESSION: the device-bound site beats the alphabetical default', async () => {
    setDeviceSite({ siteId: LONDON_SOUTH.id, siteName: LONDON_SOUTH.name });

    const { result } = renderHook(() => useSiteContext(), { wrapper });

    await waitFor(() => expect(result.current.selectedSiteId).toBe(LONDON_SOUTH.id));
    expect(result.current.selectedSite?.name).toBe('London South');
    expect(result.current.source).toBe('device');
    expect(result.current.isBound).toBe(true);
    // The whole defect, negated.
    expect(result.current.selectedSite?.name).not.toBe('Birmingham');
  });

  it('E-1: the device site beats a stale localStorage selection too', async () => {
    localStorage.setItem('autostock_selected_site', MANCHESTER.id);
    setDeviceSite({ siteId: LONDON_SOUTH.id, siteName: LONDON_SOUTH.name });

    const { result } = renderHook(() => useSiteContext(), { wrapper });

    await waitFor(() => expect(result.current.selectedSiteId).toBe(LONDON_SOUTH.id));
    expect(result.current.source).toBe('device');
  });

  it('falls back to a stored selection when no device binding exists', async () => {
    localStorage.setItem('autostock_selected_site', MANCHESTER.id);

    const { result } = renderHook(() => useSiteContext(), { wrapper });

    await waitFor(() => expect(result.current.selectedSiteId).toBe(MANCHESTER.id));
    expect(result.current.source).toBe('stored');
    expect(result.current.isBound).toBe(true);
  });

  it('falls back to the first active site — and SAYS it is not bound', async () => {
    const { result } = renderHook(() => useSiteContext(), { wrapper });

    await waitFor(() => expect(result.current.selectedSiteId).toBe(BIRMINGHAM.id));
    // This is the 12 Aug behaviour. It is still the last resort — but it is no
    // longer silent, which is the half that mattered.
    expect(result.current.source).toBe('default');
    expect(result.current.isBound).toBe(false);
  });

  it('ignores a device binding naming a site that no longer exists', async () => {
    setDeviceSite({ siteId: 'site-deleted', siteName: 'Gone' });

    const { result } = renderHook(() => useSiteContext(), { wrapper });

    await waitFor(() => expect(result.current.selectedSiteId).toBe(BIRMINGHAM.id));
    expect(result.current.isBound).toBe(false);
  });

  it('an explicit choice wins over a stored one and is marked bound', async () => {
    localStorage.setItem('autostock_selected_site', MANCHESTER.id);
    const { result } = renderHook(() => useSiteContext(), { wrapper });
    await waitFor(() => expect(result.current.selectedSiteId).toBe(MANCHESTER.id));

    result.current.setSelectedSiteId(LONDON_SOUTH.id);

    await waitFor(() => expect(result.current.selectedSiteId).toBe(LONDON_SOUTH.id));
    expect(result.current.source).toBe('user');
    expect(result.current.isBound).toBe(true);
  });

  it('chooses nothing at all before the site list arrives', async () => {
    server.use(
      http.get(`${API}/sites`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ success: true, data: SITES });
      }),
    );
    setDeviceSite({ siteId: LONDON_SOUTH.id, siteName: LONDON_SOUTH.name });

    const { result } = renderHook(() => useSiteContext(), { wrapper });

    // A blank venue chip for a moment beats a confidently wrong one.
    expect(result.current.selectedSiteId).toBeNull();
    expect(result.current.source).toBe('none');
    await waitFor(() => expect(result.current.selectedSiteId).toBe(LONDON_SOUTH.id));
  });
});
