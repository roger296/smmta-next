/**
 * "Venues & delivery" on the supplier page (supplier-ordering groundwork).
 * The wording is what head office checks a supplier's terms against, and the
 * save must send blanks as null (not known), never 0.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { ToastContextProvider } from '@/hooks/use-toast';
import { SiteAccountsTab } from './site-accounts-tab';
import { describeCutoff, describeDeliveries, describeNextDelivery } from './describe';
import type { SiteAccount, SiteAccountView } from './use-site-accounts';

const API = 'http://localhost:8080/api/v1';

const account = (over: Partial<SiteAccount> = {}): SiteAccount => ({
  id: 'acc-1',
  supplierId: 'sup-1',
  siteId: 'site-east',
  accountNumber: 'BR-104233',
  ediLocationId: null,
  deliveryDays: ['THU', 'TUE'],
  cutoffTime: '16:00:00',
  cutoffDaysBefore: 1,
  leadDays: null,
  minOrderValue: '150.00',
  deliveryCharge: '12.50',
  freeDeliveryOver: '300.00',
  orderEmail: null,
  portalUrl: null,
  notes: null,
  isActive: true,
  ...over,
});

const EAST: SiteAccountView = {
  site: { id: 'site-east', name: 'London East', timezone: 'Europe/London' },
  account: account(),
  nextDelivery: { deliveryDate: '2026-10-01', orderByLocal: '2026-09-30 16:00', basis: 'ROUND' },
};
const SOUTH: SiteAccountView = {
  site: { id: 'site-south', name: 'London South', timezone: 'Europe/London' },
  account: null,
  nextDelivery: null,
};

describe('describing an account', () => {
  it('days in week order, or a lead time', () => {
    expect(describeDeliveries(account())).toBe('Tue, Thu');
    expect(describeDeliveries(account({ deliveryDays: [], leadDays: 1 }))).toBe('1 working day');
    expect(describeDeliveries(account({ deliveryDays: [], leadDays: 3 }))).toBe('3 working days');
    expect(describeDeliveries(account({ deliveryDays: [], leadDays: null }))).toBe('Not set');
  });

  it('the cut-off in words', () => {
    expect(describeCutoff(account())).toBe('16:00, the day before');
    expect(describeCutoff(account({ cutoffDaysBefore: 0, cutoffTime: '10:00:00' }))).toBe('10:00 on the day');
    expect(describeCutoff(account({ cutoffDaysBefore: 2 }))).toBe('16:00, 2 days before');
    expect(describeCutoff(account({ deliveryDays: [], leadDays: 1, cutoffTime: '12:00:00' }))).toBe(
      "12:00 for that day's order",
    );
    expect(describeCutoff(account({ cutoffTime: null }))).toBe('—');
  });

  it('the next delivery, or why there is none', () => {
    expect(describeNextDelivery(EAST)).toBe('Thu 1 Oct — order by Wed 30 Sept 16:00');
    expect(describeNextDelivery(SOUTH)).toBe('No account');
    expect(describeNextDelivery({ ...EAST, account: account({ isActive: false }), nextDelivery: null })).toBe(
      'Switched off',
    );
    expect(describeNextDelivery({ ...EAST, nextDelivery: null })).toBe('Add delivery days or a lead time');
  });
});

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastContextProvider>
        <SiteAccountsTab supplierId="sup-1" />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
}

describe('SiteAccountsTab', () => {
  it('lists every venue, with its terms or an Add button', async () => {
    server.use(http.get(`${API}/suppliers/sup-1/site-accounts`, () => HttpResponse.json({ success: true, data: [EAST, SOUTH] })));
    renderTab();
    const east = await screen.findByTestId('site-account-site-east');
    expect(within(east).getByText('BR-104233')).toBeInTheDocument();
    expect(within(east).getByText('Tue, Thu')).toBeInTheDocument();
    expect(within(east).getByText('£150.00')).toBeInTheDocument();
    expect(within(east).getByText('free over £300.00')).toBeInTheDocument();
    const south = screen.getByTestId('site-account-site-south');
    expect(within(south).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(within(south).getByText('No account')).toBeInTheDocument();
  });

  it('adding an account sends what was typed, with blanks as null', async () => {
    let sent: unknown = null;
    server.use(
      http.get(`${API}/suppliers/sup-1/site-accounts`, () => HttpResponse.json({ success: true, data: [EAST, SOUTH] })),
      http.put(`${API}/suppliers/sup-1/site-accounts/site-south`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ success: true, data: account({ siteId: 'site-south' }) });
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await user.click(within(await screen.findByTestId('site-account-site-south')).getByRole('button', { name: 'Add' }));

    await user.type(screen.getByLabelText('Account number'), 'BR-2201');
    await user.click(screen.getByLabelText('Wed'));
    await user.click(screen.getByLabelText('Fri'));
    await user.type(screen.getByLabelText('Order cut-off'), '15:30');
    await user.type(screen.getByLabelText('Minimum order (£)'), '100');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('London South saved')).toBeInTheDocument();
    expect(sent).toEqual({
      accountNumber: 'BR-2201',
      ediLocationId: null,
      deliveryDays: ['WED', 'FRI'],
      cutoffTime: '15:30',
      cutoffDaysBefore: 1,
      leadDays: null,
      minOrderValue: 100,
      deliveryCharge: null,
      freeDeliveryOver: null,
      orderEmail: null,
      portalUrl: null,
      notes: null,
      isActive: true,
    });
  });

  it('with no delivery days ticked, asks for a lead time instead', async () => {
    server.use(http.get(`${API}/suppliers/sup-1/site-accounts`, () => HttpResponse.json({ success: true, data: [SOUTH] })));
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText('Lead time (working days)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Days before delivery')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Tue'));
    expect(screen.getByLabelText('Days before delivery')).toBeInTheDocument();
  });
});
