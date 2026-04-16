import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookInDialog, parseSerialNumbers } from './book-in-dialog';
import type { PurchaseOrder } from '@/lib/api-types';

const po: PurchaseOrder = {
  id: 'po-1',
  companyId: 'co',
  poNumber: 'PO-001',
  supplierId: 'sup-1',
  supplierName: 'Widgets Ltd',
  deliveryWarehouseId: null,
  currencyCode: 'GBP',
  deliveryCharge: '0',
  subtotal: '100',
  taxAmount: '20',
  total: '120',
  vatTreatment: 'STANDARD_VAT_20',
  exchangeRate: '1',
  expectedDeliveryDate: null,
  deliveryStatus: 'PENDING',
  invoicedStatus: 'NOT_INVOICED',
  trackingNumber: null,
  createdAt: '',
  updatedAt: '',
  lines: [
    {
      id: 'line-1',
      purchaseOrderId: 'po-1',
      productId: 'prod-1',
      productName: 'Widget A',
      quantity: '10',
      quantityReceived: '3',
      quantityInvoiced: '0',
      pricePerUnit: '5.00',
      taxRate: '20',
      lineTotal: '50.00',
      expectedDeliveryDate: null,
    },
    {
      id: 'line-2',
      purchaseOrderId: 'po-1',
      productId: 'prod-2',
      productName: 'Widget B',
      quantity: '5',
      quantityReceived: '5',
      quantityInvoiced: '0',
      pricePerUnit: '10.00',
      taxRate: '20',
      lineTotal: '50.00',
      expectedDeliveryDate: null,
    },
  ],
};

describe('parseSerialNumbers', () => {
  it('splits comma-separated values', () => {
    expect(parseSerialNumbers('SN-1,SN-2,SN-3')).toEqual(['SN-1', 'SN-2', 'SN-3']);
  });
  it('splits newline-separated values', () => {
    expect(parseSerialNumbers('SN-1\nSN-2\nSN-3')).toEqual(['SN-1', 'SN-2', 'SN-3']);
  });
  it('handles mixed separators and whitespace', () => {
    expect(parseSerialNumbers('  SN-1 , SN-2\n  SN-3  ')).toEqual(['SN-1', 'SN-2', 'SN-3']);
  });
  it('filters empty entries', () => {
    expect(parseSerialNumbers(',,SN-1,\n,')).toEqual(['SN-1']);
  });
  it('returns empty array for empty string', () => {
    expect(parseSerialNumbers('')).toEqual([]);
  });
});

describe('BookInDialog', () => {
  it('only shows lines with outstanding > 0', () => {
    render(
      <BookInDialog open onOpenChange={() => {}} po={po} onConfirm={vi.fn()} />,
    );
    expect(screen.getByText('Widget A')).toBeInTheDocument();
    // Widget B is fully received (5/5) — should not appear
    expect(screen.queryByText('Widget B')).not.toBeInTheDocument();
  });

  it('shows "all lines received" when no open lines', () => {
    const fullyReceivedPo: PurchaseOrder = {
      ...po,
      lines: [po.lines![1]!], // only the fully-received line
    };
    render(
      <BookInDialog open onOpenChange={() => {}} po={fullyReceivedPo} onConfirm={vi.fn()} />,
    );
    expect(screen.getByText(/all lines on this po are fully received/i)).toBeInTheDocument();
  });

  it('blocks book-in when no quantities entered', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <BookInDialog open onOpenChange={() => {}} po={po} onConfirm={onConfirm} />,
    );
    await user.click(screen.getByRole('button', { name: /book in/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a quantity/i);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('submits with valid quantity', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <BookInDialog open onOpenChange={() => {}} po={po} onConfirm={onConfirm} />,
    );
    const qtyInput = screen.getByLabelText(/line 1 quantity to book/i);
    await user.type(qtyInput, '5');
    await user.click(screen.getByRole('button', { name: /book in/i }));
    await new Promise((r) => setTimeout(r, 100));
    expect(onConfirm).toHaveBeenCalled();
    const arg = onConfirm.mock.calls[0]![0];
    expect(arg.lines[0].quantityBookedIn).toBe(5);
    expect(arg.lines[0].productId).toBe('prod-1');
  });
});
