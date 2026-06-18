import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { ErrorBoundary } from '@/components/error-boundary';
import { SiteProvider } from '@/features/sites/site-context';
import { isAuthenticated } from '@/lib/auth';

export const Route = createFileRoute('/_authed')({
  beforeLoad: () => {
    if (!isAuthenticated()) {
      throw redirect({ to: '/login' });
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
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </SiteProvider>
  );
}
