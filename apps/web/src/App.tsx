import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { createQueryClient } from './lib/query-client';
import { ToastContextProvider } from './hooks/use-toast';
import { PwaQueueSync } from './features/pwa/use-pwa-jobs';

const router = createRouter({ routeTree });

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
