import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { setToken } from '@/lib/auth';
import { API_BASE_URL } from '@/lib/api-client';
import { getDeviceSite, setDeviceSite } from '@/features/sites/device-site';
import { TouchScreen, BigButton } from '@/components/touch/touch';

export const Route = createFileRoute('/pin-login')({
  component: PinLoginPage,
});

/** A venue this PIN may work at (Sept-2026, item 1). */
export interface PinVenue {
  id: string;
  name: string;
  isHome: boolean;
}

interface PinResponse {
  success: boolean;
  data?: {
    token: string;
    user: {
      label: string;
      roles: string[];
      siteId: string | null;
      siteName?: string | null;
      /** Every venue this PIN may work at. One entry ⇒ no choice to make. */
      sites?: PinVenue[];
    };
  };
  error?: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'];

/** Exported so the component tests can render the screen without a router. */
export function PinLoginPage() {
  const navigate = useNavigate();
  const [pin, setPin] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  // What this iPad was bound to last time somebody signed in. Shown before
  // sign-in so the device's identity is visible from the lock screen onwards
  // (defect B-5) — and so a device set up for the wrong venue is obvious
  // before anyone books 100 kg to it (E-1).
  const [deviceSite] = React.useState(() => getDeviceSite());
  /**
   * Sept-2026 item 1: "from then on every time they login they will be
   * presented with a modal to choose their current location from the options
   * set up rather than having the default allocated automatically."
   *
   * Held until the baker picks. A default chosen for them is exactly the
   * failure E-1 was — a device quietly writing to the wrong venue — and it is
   * worse for someone who genuinely works at two.
   */
  const [choosing, setChoosing] = React.useState<{
    venues: PinVenue[];
    label: string;
    roles: string[];
  } | null>(null);

  /** Store the chosen venue and go to work. */
  const enter = (venue: PinVenue, label: string, roles: string[]) => {
    // Keep the site the PIN is scoped to. Discarding it is defect E-1.
    setDeviceSite({ siteId: venue.id, siteName: venue.name, label, roles });
    // Land on the venue home, not the desktop dashboard (defect E-2). `/` is
    // an admin page inside the admin shell, on a device with no keyboard and
    // no mouse.
    navigate({ to: '/venue' });
  };

  const press = (k: string) => {
    setError(null);
    if (k === 'clear') return setPin('');
    if (k === 'del') return setPin((p) => p.slice(0, -1));
    if (pin.length < 8) setPin((p) => p + k);
  };

  const submit = async () => {
    if (pin.length < 3) {
      setError('Enter your PIN');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/pin-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const body = (await res.json().catch(() => ({}))) as PinResponse;
      if (!res.ok || !body.success || !body.data?.token) {
        setError('Incorrect PIN');
        setPin('');
        return;
      }
      setToken(body.data.token);
      const { label, roles, siteId, siteName } = body.data.user;
      const venues =
        body.data.user.sites ??
        // A server that has not been updated yet answers without the list.
        (siteId ? [{ id: siteId, name: siteName ?? '', isHome: true }] : []);

      if (venues.length > 1) {
        // Ask. Item 1 is explicit that a multi-venue baker chooses rather than
        // being allocated one.
        setChoosing({ venues, label, roles });
        return;
      }
      const only = venues[0];
      if (!only) {
        // No venue at all — a PIN head office has not finished setting up.
        // Say so rather than landing on a screen that cannot file anything.
        setError('Your PIN is not set up for a venue yet. Ask head office.');
        setPin('');
        return;
      }
      enter(only, label, roles);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  };

  // Item 1: a baker who works at more than one venue chooses which one they
  // are at today. Deliberately NOT dismissible — every screen behind this one
  // writes to a venue, and there is no safe default to fall back to.
  if (choosing) {
    return (
      <TouchScreen>
        <div className="scroll" style={{ display: 'flex', alignItems: 'center' }}>
          <div className="center">
            <h1 style={{ textAlign: 'center' }}>Where are you today?</h1>
            <p className="lede" style={{ textAlign: 'center' }}>
              Hello {choosing.label}. Pick the venue you are working at — everything you record
              will be booked to it.
            </p>
            <div className="tile-grid">
              {choosing.venues.map((v) => (
                <button
                  key={v.id}
                  className="tile"
                  onClick={() => enter(v, choosing.label, choosing.roles)}
                >
                  {v.name}
                  {v.isHome && <span className="component">Home</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      </TouchScreen>
    );
  }

  return (
    <TouchScreen>
      <div className="scroll" style={{ display: 'flex', alignItems: 'center' }}>
        <div className="center">
          <h1 style={{ textAlign: 'center' }}>Big Bakes Stock</h1>
          <div style={{ textAlign: 'center', marginBottom: 12 }}>
            <span className={`venue-chip${deviceSite?.siteName ? '' : ' warn'}`}>
              {deviceSite?.siteName ?? 'Venue not set for this device'}
            </span>
          </div>
          <p className="lede" style={{ textAlign: 'center' }}>Enter your PIN to sign in on this device.</p>

          <div
            className="keydisplay"
            style={{ justifyContent: 'center', letterSpacing: '0.4em', fontSize: 34, marginBottom: 14 }}
            aria-label="PIN"
          >
            {pin.replace(/./g, '•') || ' '}
          </div>

          {error && <div className="notice warn" style={{ margin: '0 0 14px', textAlign: 'center' }} role="alert">{error}</div>}

          <div className="keypad">
            {KEYS.map((k) => (
              <button key={k} type="button" className="key" onClick={() => press(k)}>
                {k === 'del' ? '⌫' : k === 'clear' ? 'C' : k}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 16 }}>
            <BigButton variant="solid" onClick={() => void submit()} disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </BigButton>
          </div>

          {/* Office and head-office users still need the email form; the PWA
              just no longer sends a venue iPad there by default (E-2). */}
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <button type="button" className="linklike" onClick={() => void navigate({ to: '/login' })}>
              Sign in with email instead
            </button>
          </div>
        </div>
      </div>
    </TouchScreen>
  );
}
