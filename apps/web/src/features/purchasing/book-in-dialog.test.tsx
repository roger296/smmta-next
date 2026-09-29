/**
 * Booking in against an order from the admin page (DECISIONS.md F24): part of
 * an order, part of a line, and an over-delivery only once someone ticks it.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookInDialog, planBooking, type RowState } from './book-in-dialog';
import type { ReceivingLine, ReceivingView } from './use-purchasing';
import type { Product } from '@/lib/api-types';

const product = (id: string, name: string, purchaseUom: string) => ({ id, name, purchaseUom }) as unknown as Product;
const line = (id: string, name: string, unit: string, ordered: number, received: number): ReceivingLine => ({
  id,
  product: product(`p-${id}`, name, unit),
  ordered,
  received,
  outstanding: Math.max(0, ordered - received),
  pricePerUnit: '18.00',
  deliveryStatus: received === 0 ? 'PENDING' : received >= ordered ? 'FULLY_RECEIVED' : 'PARTIALLY_RECEIVED',
});

const VIEW: ReceivingView = {
  id: 'po-1',
  poNumber: 'PO-000123',
  supplier: { id: 's-1', name: 'Brakes' },
  site: { id: 'site-east', name: 'London East' },
  deliveryStatus: 'PARTIALLY_RECEIVED',
  expectedDeliveryDate: null,
  currencyCode: 'GBP',
  lines: [line('l-flour', 'Plain flour', 'sack', 10, 4), line('l-sugar', 'Caster sugar', 'bag', 5, 0)],
  receipts: [],
};

describe('planBooking', () => {
  const rows = (flour: string, sugar: string): RowState[] => [
    { line: VIEW.lines[0]!, qty: flour, unitCost: '18' },
    { line: VIEW.lines[1]!, qty: sugar, unitCost: '' },
  ];

  it('books only the lines with a quantity; the rest stay open', () => {
    const plan = planBooking(rows('3', ''));
    expect(plan.lines).toEqual([{ purchaseOrderLineId: 'l-flour', productId: 'p-l-flour', qtyPurchase: 3, unitCost: 18 }]);
    expect(plan.over).toEqual([]);
    expect(plan.leftOpen).toBe(2); // flour still 3 short, sugar untouched
  });

  it('everything still to come closes both lines', () => {
    expect(planBooking(rows('6', '5')).leftOpen).toBe(0);
  });

  it('more than is still to come is an over-delivery, by how much', () => {
    expect(planBooking(rows('8', '5')).over).toEqual([{ name: 'Plain flour', extra: 2, unit: 'sack' }]);
  });

  it('refuses a quantity that is not a number of zero or more', () => {
    expect(planBooking(rows('-1', 'abc')).invalid).toEqual(['Plain flour', 'Caster sugar']);
  });
});

describe('BookInDialog', () => {
  const renderDialog = (onConfirm = vi.fn().mockResolvedValue(undefined), view: ReceivingView = VIEW) => {
    render(<BookInDialog open onOpenChange={() => {}} view={view} sites={[]} onConfirm={onConfirm} />);
    return onConfirm;
  };

  it('shows ordered, received so far and still to come for every line', () => {
    renderDialog();
    const flour = screen.getByTestId('book-line-l-flour');
    expect(flour).toHaveTextContent('Plain flour');
    expect(flour).toHaveTextContent('in sacks');
    expect(flour.textContent).toMatch(/10\s*4\s*6/);
  });

  it('books part of the order and says what stays open', async () => {
    const user = userEvent.setup();
    const onConfirm = renderDialog();
    await user.type(screen.getByLabelText('Plain flour arrived now'), '2');
    expect(screen.getByRole('status')).toHaveTextContent('1 line to book · 2 lines will stay open for a later delivery');
    await user.type(screen.getByLabelText('Supplier delivery note number'), 'BR-55012');
    await user.click(screen.getByRole('button', { name: 'Book in' }));
    expect(onConfirm).toHaveBeenCalledWith({
      siteId: 'site-east',
      deliveryNoteNumber: 'BR-55012',
      acceptOverDelivery: undefined,
      lines: [{ purchaseOrderLineId: 'l-flour', productId: 'p-l-flour', qtyPurchase: 2, unitCost: 18 }],
    });
  });

  it('an over-delivery cannot be booked until someone ticks that it really arrived', async () => {
    const user = userEvent.setup();
    const onConfirm = renderDialog();
    await user.type(screen.getByLabelText('Plain flour arrived now'), '8');
    expect(screen.getByText('2 sacks more than is still to come')).toBeInTheDocument();
    const book = screen.getByRole('button', { name: 'Book in' });
    expect(book).toBeDisabled();

    await user.click(screen.getByLabelText('Book in the extra'));
    expect(book).toBeEnabled();
    await user.click(book);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ acceptOverDelivery: true }));
  });

  it('a late extra on a line already complete is shown as all extra', async () => {
    const user = userEvent.setup();
    renderDialog(undefined, { ...VIEW, lines: [line('l-sugar', 'Caster sugar', 'bag', 5, 5)] });
    await user.type(screen.getByLabelText('Caster sugar arrived now'), '1');
    expect(screen.getByText('Nothing is still to come — all 1 bag would be extra')).toBeInTheDocument();
  });

  it('"Fill in everything still to come" fills the outstanding quantities', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Fill in everything still to come' }));
    expect(screen.getByLabelText('Plain flour arrived now')).toHaveValue(6);
    expect(screen.getByLabelText('Caster sugar arrived now')).toHaveValue(5);
  });

  it('an order with no venue asks which venue it arrived at', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <BookInDialog
        open
        onOpenChange={() => {}}
        view={{ ...VIEW, site: null }}
        sites={[{ id: 'site-south', name: 'London South' }]}
        onConfirm={onConfirm}
      />,
    );
    await user.type(screen.getByLabelText('Plain flour arrived now'), '1');
    expect(screen.getByRole('button', { name: 'Book in' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Venue'), 'site-south');
    await user.click(screen.getByRole('button', { name: 'Book in' }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ siteId: 'site-south' }));
  });

  it("a refusal is shown in the dialog, which keeps what was typed", async () => {
    const user = userEvent.setup();
    renderDialog(vi.fn().mockRejectedValue(new Error('PO-000123 has been closed')));
    await user.type(screen.getByLabelText('Plain flour arrived now'), '2');
    await user.click(screen.getByRole('button', { name: 'Book in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('has been closed');
    expect(screen.getByLabelText('Plain flour arrived now')).toHaveValue(2);
  });
});
