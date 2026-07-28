import { Button } from '@/components/ui/button';
import { clearToken, decodeJwt, getToken } from '@/lib/auth';
import { useNavigate } from '@tanstack/react-router';
import { LogOut, Menu } from 'lucide-react';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Sidebar } from './sidebar';
import { SiteSwitcher } from './site-switcher';

export function Header() {
  const navigate = useNavigate();
  const token = getToken();
  const user = token ? decodeJwt(token) : null;

  const handleLogout = () => {
    clearToken();
    navigate({ to: '/login' });
  };

  return (
    <header className="flex h-14 items-center justify-between border-b border-[var(--color-shell-border)] bg-[var(--color-shell)] px-6 text-[var(--color-shell-foreground)]">
      <div className="flex items-center gap-3">
        {/* The mark rides in the header on wide screens, where the sidebar
            already carries it; on mobile the sidebar is hidden, so this is the
            only place the brand appears. */}
        <img
          src="/logos/big-bakes.png"
          alt="Big Bakes"
          className="hidden h-8 w-auto md:block"
        />
        <Sheet>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-[var(--color-shell-foreground)] hover:bg-[var(--color-shell-hover)] hover:text-white md:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0">
            <div className="flex h-full flex-col">
              <Sidebar alwaysShow />
            </div>
          </SheetContent>
        </Sheet>
      </div>
      <div className="flex items-center gap-4">
        <SiteSwitcher />
        {user && (
          <span className="hidden text-sm text-[var(--color-shell-muted)] sm:inline">{user.email}</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-[var(--color-shell-foreground)] hover:bg-[var(--color-shell-hover)] hover:text-white"
          onClick={handleLogout}
          aria-label="Sign out"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </header>
  );
}
