/**
 * Booking a delivery in against an order on the venue iPad (DECISIONS.md F24).
 *
 * Owner request: book in part of an order — some lines and not others, or part
 * of a line — with the rest left for later; and make sure an over-delivery can
 * be booked when necessary.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { ToastContextProvider } from '@/hooks/use-toast';
import { pwaQueue } from '@/features/pwa/use-pwa-jobs';
import { tokenWithRoles } from '@/test/tokens';
import { GoodsInScreen } from './goods-in';

const API = 'http://localhost:8080/api/v1';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@tanstack/react-router');
  return { ...actual, createFileRoute: () => () => ({ component: null }), useNavigate: () => vi.fn() };
});

const SITE = { id: 'site-east', name: 'London East', isActive: true };
vi.mock('@/features/sites/site-context', () => ({
  useSiteContext: () => ({
    sites: [SITE],
    isLoading: false,
    selectedSiteId: SITE.id,
    selectedSite: SITE,
    setSelectedSiteId: vi.fn(),
    source: 'device',
    isBound: true,
  }),
  SiteProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const product = (id: string, name: string, purchaseUom: string, factor: string) => ({
  id,
  name,
  stockCode: id.toUpperCase(),
  barcode: `bc-${id}`,
  stockUom: 'g',
  purchaseUom,
  purchaseToStockFactor: factor,
  expectedNextCost: '18.00',
  requireBatchNumber: false,
});
const FLOUR = product('flour', 'Plain flour', 'sack', '16000');
const SUGAR = product('sugar', 'Caster sugar', 'bag', '1000');
const COCOA = product('cocoa', 'Cocoa powder', 'tub', '500');
const CUPS = product('cups', 'Paper cups', 'case', '1');

const VIEW = {
  id: 'po-1',
  poNumber: 'PO-000123',
  supplier: { id: 's-1', name: 'Brakes' },
  site: { id: SITE.id, name: SITE.name },
  deliveryStatus: 'PARTIALLY_RECEIVED',
  expectedDeliveryDate: '2026-10-01',
  currencyCode: 'GBP',
  lines: [
    { id: 'l-flour', product: FLOUR, ordered: 10, received: 4, outstanding: 6, pricePerUnit: '18.00', deliveryStatus: 'PARTIALLY_RECEIVED' },
    { id: 'l-sugar', product: SUGAR, ordered: 5, received: 5, outstanding: 0, pricePerUnit: '1.20', deliveryStatus: 'FULLY_RECEIVED' },
    { id: 'l-cocoa', product: COCOA, ordered: 3, received: 0, outstanding: 3, pricePerUnit: '9.00', deliveryStatus: 'PENDING' },
  ],
  receipts: [],
};

const RECEIPT = {
  receipt: { id: 'receipt-1', siteId: SITE.id, reference: null, totalStockValue: '108.00', receivedAt: '2026-09-29T10:00:00.000Z' },
  lines: [],
  alreadyExisted: false,
};

let posted: Record<string, unknown> | null;

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('smmta_token', tokenWithRoles(['head_baker'], SITE.id));
  for (const a of await pwaQueue.list()) await pwaQueue.discard(a.idempotencyKey);
  posted = null;
  server.use(
    http.get(`${API}/goods-in/expected`, () =>
      HttpResponse.json({
        success: true,
        data: [{ id: 'po-1', poNumber: 'PO-000123', supplierName: 'Brakes', expectedDeliveryDate: '2026-10-01', deliveryStatus: 'PARTIALLY_RECEIVED', lines: 3, linesOutstanding: 2 }],
      }),
    ),
    http.get(`${API}/purchase-orders/po-1/receiving`, () => HttpResponse.json({ success: true, data: VIEW })),
    http.post(`${API}/goods-in`, async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ success: true, data: RECEIPT }, { status: 201 });
    }),
  );
});

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastContextProvider>
        <GoodsInScreen />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
}

const rowOf = (name: string) => screen.getByText(name).closest('.row') as HTMLElement;

async function pickOrder(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Book in against an order' }));
  const list = await screen.findByTestId('expected-orders');
  expect(list).toHaveTextContent('2 of 3 lines still to come');
  await user.click(within(list).getByRole('button', { name: /PO-000123/ }));
  await screen.findByTestId('order-banner');
}

describe('booking against an order on the iPad', () => {
  it('lays out every line still to come at what is still to come — not the complete ones', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickOrder(user);

    expect(screen.getByTestId('order-banner')).toHaveTextContent('PO-000123 · Brakes');
    expect(within(rowOf('Plain flour')).getByRole('button', { name: /type received quantity/i })).toHaveTextContent('6');
    expect(rowOf('Plain flour')).toHaveTextContent('Ordered 10 sack · 4 in already · 6 to come');
    expect(within(rowOf('Cocoa powder')).getByRole('button', { name: /type received quantity/i })).toHaveTextContent('3');
    expect(screen.queryByText('Caster sugar')).not.toBeInTheDocument();
  });

  it("some lines, not others: a line set to 0 isn't booked and stays on the order", async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickOrder(user);
    const cocoa = rowOf('Cocoa powder');
    for (let i = 0; i < 3; i++) await user.click(within(cocoa).getByRole('button', { name: /^decrease$/i }));
    expect(cocoa).toHaveTextContent('didn’t come — stays on the order');

    await user.click(screen.getByRole('button', { name: /book in 1 line/i }));
    expect(screen.getByText('1 line will stay on the order for a later delivery.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Delivery note number'), 'BR-55012');
    await user.click(screen.getByRole('button', { name: 'Confirm and book in' }));

    await screen.findByText(/PO-000123 · note BR-55012/);
    expect(posted).toMatchObject({
      siteId: SITE.id,
      purchaseOrderId: 'po-1',
      deliveryNoteNumber: 'BR-55012',
      lines: [{ productId: 'flour', qtyPurchase: 6, purchaseOrderLineId: 'l-flour' }],
    });
    expect(posted!.acceptOverDelivery).toBeUndefined();
  });

  it('part of a line: the rest stays to come', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickOrder(user);
    await user.click(within(rowOf('Plain flour')).getByRole('button', { name: /^decrease$/i }));
    await user.click(screen.getByRole('button', { name: /book in 2 lines/i }));
    expect(screen.getByText('1 line will stay on the order for a later delivery.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm and book in' }));
    await screen.findByText(/PO-000123/);
    expect((posted!.lines as Array<{ qtyPurchase: number }>)[0]!.qtyPurchase).toBe(5);
  });

  it('an over-delivery is shown before booking, and confirming it accepts it', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickOrder(user);
    await user.click(within(rowOf('Plain flour')).getByRole('button', { name: /^increase$/i }));
    expect(rowOf('Plain flour')).toHaveTextContent('more than ordered');

    await user.click(screen.getByRole('button', { name: /book in 2 lines/i }));
    expect(screen.getByTestId('over-delivery')).toHaveTextContent('Plain flour: 1 sack extra');
    expect(screen.getByText('This completes the order.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm, including the extra' }));

    await screen.findByText(/PO-000123/);
    expect(posted).toMatchObject({ acceptOverDelivery: true });
    expect((posted!.lines as Array<{ qtyPurchase: number }>)[0]!.qtyPurchase).toBe(7);
  });

  it('an item scanned that is not on the order is flagged, and is an extra', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${API}/products/by-code/:code`, () => HttpResponse.json({ success: true, data: CUPS })));
    renderScreen();
    await pickOrder(user);
    await user.type(screen.getByLabelText(/product code/i), 'bc-cups');
    await user.click(screen.getByRole('button', { name: /\+ add/i }));
    expect(await screen.findByText('Not on this order')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /book in 3 lines/i }));
    expect(screen.getByTestId('over-delivery')).toHaveTextContent('Paper cups: not on the order (1 case)');
    await user.click(screen.getByRole('button', { name: 'Confirm, including the extra' }));
    await screen.findByText(/PO-000123/);
    const cups = (posted!.lines as Array<{ productId: string; purchaseOrderLineId?: string }>).find((l) => l.productId === 'cups');
    expect(cups!.purchaseOrderLineId).toBeUndefined();
  });

  it('a refusal (another iPad booked it first) keeps everything on screen and says why', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/goods-in`, () =>
        HttpResponse.json(
          { success: false, code: 'OVER_DELIVERY', error: 'More than was ordered: Plain flour — ordered 10, already received 10, booking 6.' },
          { status: 409 },
        ),
      ),
    );
    renderScreen();
    await pickOrder(user);
    await user.click(screen.getByRole('button', { name: /book in 2 lines/i }));
    await user.click(screen.getByRole('button', { name: 'Confirm and book in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already received 10');
    expect(screen.getByTestId('order-banner')).toBeInTheDocument();
    expect(screen.getByText('Plain flour')).toBeInTheDocument();
  });

  it('"Not against an order" keeps what arrived and drops the empty placeholders', async () => {
    const user = userEvent.setup();
    renderScreen();
    await pickOrder(user);
    const cocoa = rowOf('Cocoa powder');
    for (let i = 0; i < 3; i++) await user.click(within(cocoa).getByRole('button', { name: /^decrease$/i }));
    await user.click(screen.getByRole('button', { name: 'Not against an order' }));
    expect(screen.queryByTestId('order-banner')).not.toBeInTheDocument();
    expect(screen.getByText('Plain flour')).toBeInTheDocument();
    expect(screen.queryByText('Cocoa powder')).not.toBeInTheDocument();
  });
});
