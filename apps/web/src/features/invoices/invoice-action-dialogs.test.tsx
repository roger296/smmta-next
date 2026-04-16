import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AllocatePaymentDialog, CreditNoteDialog } from './invoice-action-dialogs';
import type { Invoice } from '@/lib/api-types';

const invoice: Invoice = {
  id: 'inv-1',
  companyId: 'co',
  invoiceNumber: 'INV-001',
  orderId: 'ord-1',
  customerId: 'cust-1',
  customerName: 'Acme',
  status: 'ISSUED',
  dateOfInvoice: '2026-04-01',
  dueDateOfInvoice: '2026-05-01',
  subtotal: '100.00',
  taxAmount: '20.00',
  total: '120.00',
  paidAmount: '0.00',
  outstandingAmount: '120.00',
  lines: [
    {
      id: 'line-1',
      invoiceId: 'inv-1',
      productId: 'prod-1',
      productName: 'Widget',
      quantity: '2',
      pricePerUnit: '50.00',
      taxRate: '20',
      lineTotal: '100.00',
      lineTax: '20.00',
    },
  ],
  createdAt: '2026-04-01',
  updatedAt: '2026-04-01',
};

describe('AllocatePaymentDialog', () => {
  it('blocks amount greater than outstanding', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <AllocatePaymentDialog
        open
        onOpenChange={() => {}}
        invoice={invoice}
        onConfirm={onConfirm}
      />,
    );
    const amount = screen.getByLabelText(/amount/i);
    await user.clear(amount);
    await user.type(amount, '200');
    await user.click(screen.getByRole('button', { name: /record payment/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot exceed/i);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onConfirm with valid input', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <AllocatePaymentDialog
        open
        onOpenChange={() => {}}
        invoice={invoice}
        onConfirm={onConfirm}
      />,
    );
    // Amount defaults to outstanding (120)
    await user.click(screen.getByRole('button', { name: /record payment/i }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 120 }),
    );
  });
});

describe('CreditNoteDialog', () => {
  it('enables issue button only after selecting a line', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <CreditNoteDialog
        open
        onOpenChange={() => {}}
        invoice={invoice}
        onConfirm={onConfirm}
      />,
    );
    const issueBtn = screen.getByRole('button', { name: /issue credit note/i });
    expect(issueBtn).toBeDisabled();
    const checkbox = screen.getByLabelText(/select line 1/i);
    await user.click(checkbox);
    expect(issueBtn).not.toBeDisabled();
  });

  it('blocks credit quantity greater than original qty', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <CreditNoteDialog
        open
        onOpenChange={() => {}}
        invoice={invoice}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByLabelText(/select line 1/i));
    const qty = screen.getByLabelText(/line 1 credit quantity/i);
    await user.clear(qty);
    await user.type(qty, '5');
    await user.click(screen.getByRole('button', { name: /issue credit note/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot exceed/i);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
