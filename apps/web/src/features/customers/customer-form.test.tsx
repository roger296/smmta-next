import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/server';
import { CustomerForm } from './customer-form';

const API = 'http://localhost:3000/api/v1';

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('CustomerForm', () => {
  it('renders required fields', () => {
    server.use(http.get(`${API}/customer-types`, () => HttpResponse.json({ success: true, data: [] })));
    wrap(<CustomerForm onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/credit limit/i)).toBeInTheDocument();
  });

  it('shows validation error when name is empty', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${API}/customer-types`, () => HttpResponse.json({ success: true, data: [] })));
    const onSubmit = vi.fn();
    wrap(<CustomerForm onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: /save|create/i }));
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits cleaned values (strips empty strings)', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${API}/customer-types`, () => HttpResponse.json({ success: true, data: [] })));
    const onSubmit = vi.fn();
    wrap(<CustomerForm onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/^name/i), 'Acme Ltd');
    await user.click(screen.getByRole('button', { name: /save|create/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const arg = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.name).toBe('Acme Ltd');
    expect(arg.creditLimit).toBe(0);
    expect(arg.creditCurrencyCode).toBe('GBP');
    expect(arg.creditTermDays).toBe(30);
    // Optional fields not filled should not be present
    expect('email' in arg).toBe(false);
    expect('shortName' in arg).toBe(false);
  });

  it('rejects invalid email', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${API}/customer-types`, () => HttpResponse.json({ success: true, data: [] })));
    const onSubmit = vi.fn();
    wrap(<CustomerForm onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/^name/i), 'Acme');
    await user.type(screen.getByLabelText(/email/i), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /save|create/i }));
    // Validation fails: onSubmit should not be called. Don't assert on exact error text
    // because Zod union errors can have varied wording.
    await new Promise((r) => setTimeout(r, 200));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
