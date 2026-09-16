/**
 * Choosing your venue at sign-in (Sept-2026 user testing, item 1).
 *
 * "from then on every time they login they will be presented with a modal to
 *  choose their current location from the options set up rather than having the
 *  default allocated automatically."
 *
 * The emphasis is the point. A default chosen for a baker is exactly the
 * failure defect E-1 was — a device quietly writing to the wrong venue — and it
 * is worse for someone who genuinely works at two.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { getDeviceSite } from '@/features/sites/device-site';

const API = 'http://localhost:8080/api/v1';
const navigate = vi.fn();

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@tanstack/react-router');
  return { ...actual, createFileRoute: () => () => ({ component: null }), useNavigate: () => navigate };
});

const HOME = { id: 'site-east', name: 'London East', isHome: true };
const SECOND = { id: 'site-south', name: 'London South', isHome: false };

function stubLogin(sites: unknown[] | undefined) {
  server.use(
    http.post(`${API}/auth/pin-login`, () =>
      HttpResponse.json({
        success: true,
        data: {
          token: 'header.eyJ1c2VySWQiOiJwaW46MSJ9.sig',
          user: {
            label: 'Sam',
            roles: ['head_baker'],
            siteId: HOME.id,
            siteName: HOME.name,
            ...(sites === undefined ? {} : { sites }),
          },
        },
      }),
    ),
  );
}

beforeEach(() => {
  navigate.mockClear();
  localStorage.clear();
});

/** Tap a PIN in on the on-screen keypad. */
async function enterPin(user: ReturnType<typeof userEvent.setup>, pin = '778811') {
  for (const d of pin) await user.click(screen.getByRole('button', { name: d }));
  await user.click(screen.getByRole('button', { name: /^Sign in$/ }));
}

describe('a baker with one venue', () => {
  it('goes straight to work — nothing to choose', async () => {
    const { PinLoginPage } = await import('./pin-login');
    stubLogin([HOME]);
    const user = userEvent.setup();
    render(<PinLoginPage />);
    await enterPin(user);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/venue' }));
    expect(getDeviceSite()?.siteName).toBe('London East');
  });

  it('still works against a server that has not been updated', async () => {
    // Older servers answer without the venue list. Treating that as "no
    // venues" would lock every baker out at the moment this deployed.
    const { PinLoginPage } = await import('./pin-login');
    stubLogin(undefined);
    const user = userEvent.setup();
    render(<PinLoginPage />);
    await enterPin(user);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/venue' }));
    expect(getDeviceSite()?.siteId).toBe(HOME.id);
  });
});

describe('a baker with two venues', () => {
  it('is asked which one, and is NOT sent anywhere until they answer', async () => {
    const { PinLoginPage } = await import('./pin-login');
    stubLogin([HOME, SECOND]);
    const user = userEvent.setup();
    render(<PinLoginPage />);
    await enterPin(user);

    expect(await screen.findByText(/where are you today/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    // No venue is written until they pick — a half-answered sign-in must not
    // leave the device pointing anywhere.
    expect(getDeviceSite()).toBeNull();
  });

  it('books to the venue they pick, not the home one', async () => {
    const { PinLoginPage } = await import('./pin-login');
    stubLogin([HOME, SECOND]);
    const user = userEvent.setup();
    render(<PinLoginPage />);
    await enterPin(user);
    await screen.findByText(/where are you today/i);

    await user.click(screen.getByRole('button', { name: /London South/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/venue' }));
    expect(getDeviceSite()).toMatchObject({ siteId: SECOND.id, siteName: 'London South' });
  });

  it('marks which one is home, so the usual choice is obvious', async () => {
    const { PinLoginPage } = await import('./pin-login');
    stubLogin([HOME, SECOND]);
    const user = userEvent.setup();
    render(<PinLoginPage />);
    await enterPin(user);

    const homeTile = await screen.findByRole('button', { name: /London East/ });
    expect(homeTile).toHaveTextContent('Home');
  });
});

describe('a PIN with no venue at all', () => {
  it('says so instead of landing on screens that cannot file anything', async () => {
    const { PinLoginPage } = await import('./pin-login');
    server.use(
      http.post(`${API}/auth/pin-login`, () =>
        HttpResponse.json({
          success: true,
          data: {
            token: 'header.eyJ1c2VySWQiOiJwaW46MSJ9.sig',
            user: { label: 'Sam', roles: ['head_baker'], siteId: null, siteName: null, sites: [] },
          },
        }),
      ),
    );
    const user = userEvent.setup();
    render(<PinLoginPage />);
    await enterPin(user);

    expect(await screen.findByText(/not set up for a venue yet/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
