import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { createQueryClient } from './lib/query-client';
import { ToastContextProvider } from './hooks/use-toast';
import { PwaQueueSync } from './features/pwa/use-pwa-jobs';
import { RoutePending } from './components/layout/route-pending';

const router = createRouter({
  routeTree,
  /*
   * A slow screen shows a skeleton rather than a blank flash (B-7).
   *
   * `defaultPendingMs: 150` keeps it off the fast paths — a skeleton that
   * appears and vanishes inside a frame is its own kind of abrupt. Once shown
   * it stays for at least 300ms, so it reads as "loading" rather than a
   * flicker.
   */
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 150,
  defaultPendingMinMs: 300,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = createQueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastContextProvider>
        {/*
          Replays the venue offline queue on boot / `online` / tab-visible.
          Defect A-2: `flushPwaQueue` had no production call site at all, so
          work captured offline sat in localStorage for ever.

          Mounted at the app root, and staying there. The queue is
          process-global and a device may regain connectivity on any page —
          including /pin-login, before anyone has signed back in. Scoping this
          to the `_touch` layout would leave unsent work waiting until someone
          navigated back to a venue screen.
        */}
        <PwaQueueSync />
        <RouterProvider router={router} />
      </ToastContextProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
