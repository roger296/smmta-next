import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { setToken } from '@/lib/auth';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [token, setTokenInput] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError('Please paste a JWT token');
      return;
    }
    if (!/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(trimmed)) {
      setError('That does not look like a valid JWT');
      return;
    }
    setToken(trimmed);
    navigate({ to: '/' });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-muted)] px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in to SMMTA-Next</CardTitle>
          <CardDescription>
            Paste a JWT token generated via{' '}
            <code className="rounded bg-[var(--color-muted)] px-1 text-xs">
              npx tsx apps/api/generate-test-token.ts
            </code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="token">JWT Token</Label>
              <Input
                id="token"
                name="token"
                type="text"
                value={token}
                onChange={(e) => {
                  setTokenInput(e.target.value);
                  setError(null);
                }}
                placeholder="eyJhbGciOi..."
                autoComplete="off"
                autoFocus
              />
              {error && (
                <p role="alert" className="text-sm text-[var(--color-destructive)]">
                  {error}
                </p>
              )}
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
