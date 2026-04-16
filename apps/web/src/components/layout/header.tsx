import { Button } from '@/components/ui/button';
import { clearToken, decodeJwt, getToken } from '@/lib/auth';
import { useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';

export function Header() {
  const navigate = useNavigate();
  const token = getToken();
  const user = token ? decodeJwt(token) : null;

  const handleLogout = () => {
    clearToken();
    navigate({ to: '/login' });
  };

  return (
    <header className="flex h-14 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-card)] px-6">
      <div />
      <div className="flex items-center gap-4">
        {user && (
          <span className="text-sm text-[var(--color-muted-foreground)]">{user.email}</span>
        )}
        <Button variant="ghost" size="sm" onClick={handleLogout} aria-label="Sign out">
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </header>
  );
}
