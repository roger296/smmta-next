import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { setToken } from '@/lib/auth';
import { API_BASE_URL } from '@/lib/api-client';

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
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-muted)] px-4">
      <Card className="w-full max-w-xs">
        <CardHeader className="text-center">
          <CardTitle>Auto-Stock</CardTitle>
          <CardDescription>Enter your PIN to sign in on this device.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className="flex h-12 items-center justify-center rounded-md border border-[var(--color-border)] text-2xl tracking-[0.5em]"
            aria-label="PIN"
          >
            {pin.replace(/./g, '•') || ' '}
          </div>
          {error && (
            <p role="alert" className="text-center text-sm text-[var(--color-destructive)]">
              {error}
            </p>
          )}
          <div className="grid grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <Button
                key={k}
                type="button"
                variant={k === 'clear' || k === 'del' ? 'outline' : 'secondary'}
                className="h-14 text-lg"
                onClick={() => press(k)}
              >
                {k === 'del' ? '⌫' : k === 'clear' ? 'C' : k}
              </Button>
            ))}
          </div>
          <Button className="w-full" onClick={submit} disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
