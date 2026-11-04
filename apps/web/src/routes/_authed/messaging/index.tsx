import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_authed/messaging/')({
  beforeLoad: () => {
    throw redirect({ to: '/messaging/campaigns' });
  },
});
