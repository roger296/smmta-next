import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { ErrorBoundary } from '@/components/error-boundary';
import { RouteFade } from '@/components/layout/route-fade';
import { SiteProvider } from '@/features/sites/site-context';
import { isAuthenticated } from '@/lib/auth';
import { signInRouteFor } from '@/lib/display-mode';

export const Route = createFileRoute('/_authed')({
  beforeLoad: ({ location }) => {
    if (!isAuthenticated()) {
      // Redirect by DEVICE, not by guesswork (defect E-2). An installed
      // home-screen icon is a venue iPad and belongs on the PIN screen; a
      // browser tab is somebody at a desk and belongs on the email form.
      // `/login` stays reachable either way.
      throw redirect({ to: signInRouteFor(location.pathname) });
    }
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  return (
    <SiteProvider>
      <div className="flex min-h-screen bg-[var(--color-background)]">
        <Sidebar />
        <div className="flex flex-1 flex-col">
          <Header />
          <main className="flex-1 overflow-auto p-6">
            <ErrorBoundary>
              {/* "Page transitions feel quite abrupt" (B-7). A 140ms
                  cross-fade, skipped entirely under prefers-reduced-motion. */}
              <RouteFade>
                <Outlet />
              </RouteFade>
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </SiteProvider>
  );
}
