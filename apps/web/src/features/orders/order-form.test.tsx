import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { OrderForm } from './order-form';

const API = 'http://localhost:8080/api/v1';

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function setupStubs() {
  server.use(
    http.get(`${API}/customers`, () =>
      HttpResponse.json({
        success: true,
        data: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Acme' }],
        total: 1,
        page: 1,
        pageSize: 200,
        totalPages: 1,
      }),
    ),
    http.get(`${API}/products`, () =>
      HttpResponse.json({
        success: true,
        data: [
          {
            id: '22222222-2222-2222-2222-222222222222',
            name: 'Widget',
            stockCode: 'WID-1',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 500,
        totalPages: 1,
      }),
    ),
    http.get(`${API}/warehouses`, () =>
      HttpResponse.json({ success: true, data: [] }),
    ),
  );
}

describe('OrderForm', () => {
  it('renders with at least one line row and totals', async () => {
    setupStubs();
    wrap(<OrderForm onSubmit={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /add line/i })).toBeInTheDocument();
    expect(screen.getByText(/subtotal/i)).toBeInTheDocument();
    // "Total" appears in totals section (multiple usages acceptable)
    expect(screen.getAllByText(/^total$/i).length).toBeGreaterThan(0);
  });

  it('calculates live totals from line qty * price', async () => {
    const user = userEvent.setup();
    setupStubs();
    wrap(<OrderForm onSubmit={vi.fn()} />);
    const qtyInput = await screen.findByLabelText(/line 1 quantity/i);
    const priceInput = screen.getByLabelText(/line 1 unit price/i);
    await user.clear(qtyInput);
    await user.type(qtyInput, '5');
    await user.clear(priceInput);
    await user.type(priceInput, '10');
    // Subtotal should become 50. Total = 50 + 20% tax (10) + 0 delivery = 60.
    await waitFor(() => {
      expect(screen.getAllByText(/£50\.00/).length).toBeGreaterThan(0);
    });
  });

  it('adds and removes line items', async () => {
    const user = userEvent.setup();
    setupStubs();
    wrap(<OrderForm onSubmit={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /add line/i }));
    expect(screen.getByLabelText(/line 2 quantity/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/remove line 2/i));
    await waitFor(() =>
      expect(screen.queryByLabelText(/line 2 quantity/i)).not.toBeInTheDocument(),
    );
  });

  it('blocks submit when no customer selected', async () => {
    const user = userEvent.setup();
    setupStubs();
    const onSubmit = vi.fn();
    wrap(<OrderForm onSubmit={onSubmit} />);
    await screen.findByRole('button', { name: /add line/i });
    await user.click(screen.getByRole('button', { name: /create order|save/i }));
    await new Promise((r) => setTimeout(r, 300));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
