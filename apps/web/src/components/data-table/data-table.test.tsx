import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable, Pagination } from './data-table';
import type { ColumnDef } from '@tanstack/react-table';

interface Row {
  id: string;
  name: string;
  qty: number;
}

const columns: ColumnDef<Row>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'qty', header: 'Qty' },
];

describe('DataTable', () => {
  it('renders rows', () => {
    render(
      <DataTable
        columns={columns}
        data={[
          { id: '1', name: 'Alice', qty: 3 },
          { id: '2', name: 'Bob', qty: 1 },
        ]}
      />,
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows empty message when data empty', () => {
    render(<DataTable columns={columns} data={[]} emptyMessage="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('invokes onRowClick with full row', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={[{ id: '1', name: 'Alice', qty: 3 }]}
        onRowClick={onRowClick}
      />,
    );
    await user.click(screen.getByText('Alice'));
    expect(onRowClick).toHaveBeenCalledWith({ id: '1', name: 'Alice', qty: 3 });
  });
});

describe('Pagination', () => {
  it('disables Previous on page 1', () => {
    render(<Pagination page={1} pageSize={10} total={30} onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled();
  });

  it('disables Next on last page', () => {
    render(<Pagination page={3} pageSize={10} total={30} onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('calls onPageChange with next page', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<Pagination page={1} pageSize={10} total={30} onPageChange={onPageChange} />);
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('shows correct page info', () => {
    render(<Pagination page={2} pageSize={10} total={25} onPageChange={() => {}} />);
    expect(screen.getByText(/page 2 of 3/i)).toBeInTheDocument();
    expect(screen.getByText(/25 total/i)).toBeInTheDocument();
  });
});
