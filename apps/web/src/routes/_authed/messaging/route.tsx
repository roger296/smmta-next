import { createFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useOverview } from '@/features/email/api';
import { cn } from '@/lib/utils';

/**
 * Messaging: every email the store sends (docs/email). A banner across every
 * page says what the sender is doing — red unless mode is live and marketing
 * is running — so nobody wonders why nothing is being delivered.
 */
export const Route = createFileRoute('/_authed/messaging')({ component: MessagingLayout });

const TABS = [
  { to: '/messaging/campaigns', label: 'Campaigns' },
  { to: '/messaging/contacts', label: 'Contacts' },
  { to: '/messaging/imports', label: 'Imports' },
  { to: '/messaging/automations', label: 'Automations' },
  { to: '/messaging/templates', label: 'Templates' },
  { to: '/messaging/deliverability', label: 'Deliverability' },
  { to: '/messaging/settings', label: 'Settings' },
] as const;

function Banner() {
  const { data } = useOverview();
  if (!data) return null;
  const live = data.sendMode === 'live';
  const red = !live || data.marketingPaused;
  const mode = !data.sendModeSet
    ? 'Sending is OFF: EMAIL_SEND_MODE is not set.'
    : data.sendMode === 'sandbox'
      ? 'Sandbox mode: SendGrid accepts mail but delivers nothing.'
      : data.sendMode === 'allowlist'
        ? 'Allowlist mode: only the test addresses receive mail.'
        : 'Live: mail is delivered.';
  return (
    <div data-testid="send-mode-banner" className={cn('rounded-md border px-4 py-2 text-sm', red ? 'border-red-300 bg-red-50 text-red-800' : 'border-green-300 bg-green-50 text-green-800')}>
      <strong>{mode}</strong>
      {data.marketingPaused ? <span> Marketing is paused{data.pausedReason ? ` — ${data.pausedReason}` : ''}.</span> : null}
      {data.pendingApproval ? <span> {data.pendingApproval} campaign(s) waiting for approval.</span> : null}
      {data.openAlerts ? <span> {data.openAlerts} deliverability alert(s).</span> : null}
    </div>
  );
}

function MessagingLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Messaging</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Every email the store sends: consent, campaigns, automations and delivery.</p>
      </div>
      <Banner />
      <nav className="flex flex-wrap gap-1 border-b border-[var(--color-border)]">
        {TABS.map((t) => (
          <Link key={t.to} to={t.to} className={cn('-mb-px border-b-2 px-3 py-2 text-sm', path.startsWith(t.to) ? 'border-[var(--color-primary)] font-medium' : 'border-transparent text-[var(--color-muted-foreground)]')}>
            {t.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
