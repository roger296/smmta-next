import { Button } from '@/components/ui/button';
import { clearToken, decodeJwt, getToken } from '@/lib/auth';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { LogOut, Menu } from 'lucide-react';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { NAV_ITEMS, Sidebar, activePath } from './sidebar';
import { SiteSwitcher } from './site-switcher';

/**
 * The section this page belongs to, for the header's breadcrumb line
 * (Aug-2026, B-7).
 *
 * Reuses `activePath` rather than re-deriving it, so the breadcrumb and the
 * highlighted nav row can never disagree about where you are — which would be
 * worse than having no breadcrumb at all.
 */
export function sectionLabel(pathname: string): string | null {
  const active = activePath(pathname, NAV_ITEMS);
  return NAV_ITEMS.find((i) => i.to === active)?.label ?? null;
}

export function Header() {
  const navigate = useNavigate();
  const { location } = useRouterState();
  const token = getToken();
  const user = token ? decodeJwt(token) : null;
  const section = sectionLabel(location.pathname);

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
        {/* "Confirm the active page" (B-7). The salmon nav highlight only
            helps if the sidebar is in view; collapsed to an icon rail, or on
            a narrow screen with no sidebar at all, this line is the answer. */}
        {section && (
          <nav aria-label="Breadcrumb" className="hidden items-center gap-2 text-sm sm:flex">
            <span className="text-[var(--color-shell-muted)]">Big Bakes Stock</span>
            <span aria-hidden className="text-[var(--color-shell-muted)]">/</span>
            <span aria-current="page" className="font-semibold text-white">
              {section}
            </span>
          </nav>
        )}
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
