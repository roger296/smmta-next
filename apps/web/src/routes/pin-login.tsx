import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { setToken } from '@/lib/auth';
import { API_BASE_URL } from '@/lib/api-client';
import { TouchScreen, BigButton } from '@/components/touch/touch';

export const Route = createFileRoute('/pin-login')({
  component: PinLoginPage,
});

interface PinResponse {
  success: boolean;
  data?: { token: string; user: { label: string; roles: string[]; siteId: string | null } };
  error?: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'];

function PinLoginPage() {
  const navigate = useNavigate();
  const [pin, setPin] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

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
      navigate({ to: '/' });
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TouchScreen>
      <div className="scroll" style={{ display: 'flex', alignItems: 'center' }}>
        <div className="center">
          <h1 style={{ textAlign: 'center' }}>Auto-Stock</h1>
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
        </div>
      </div>
    </TouchScreen>
  );
}
