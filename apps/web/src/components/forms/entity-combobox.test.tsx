/**
 * EntityCombobox behaviour.
 *
 * The component it replaces loaded every row up front, so there was nothing to
 * test beyond "did the list render". A search box has real interaction rules —
 * debouncing, keyboard selection, and what happens when someone types over an
 * existing choice — and those are what these cover.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { EntityCombobox, MAX_VISIBLE_OPTIONS, type ComboboxOption } from './entity-combobox';

const OPTIONS: ComboboxOption[] = [
  { id: 'p1', label: 'Landau PLA Basic 1.75mm 1kg — Green', sublabel: 'V3-PLA-BAS-GREEN' },
  { id: 'p2', label: 'Landau PLA Matte 1.75mm 1kg — Green', sublabel: 'V3-PLA-MAT-GREEN' },
  { id: 'p3', label: 'Landau PETG 1.75mm 1kg — Red', sublabel: 'V3-PETG-REG-RED' },
];

/** Wrapper so selection state behaves as it does in a real form. */
function Harness({
  options = OPTIONS,
  onSearchTermChange = () => {},
  initial,
}: {
  options?: ComboboxOption[];
  onSearchTermChange?: (t: string) => void;
  initial?: string;
}) {
  const [value, setValue] = useState<string | undefined>(initial);
  const selected = options.find((o) => o.id === value);
  return (
    <>
      <EntityCombobox
        id="picker"
        value={value}
        onChange={setValue}
        options={options}
        onSearchTermChange={onSearchTermChange}
        selectedLabel={selected?.label ?? null}
      />
      <output data-testid="value">{value ?? 'none'}</output>
    </>
  );
}

describe('EntityCombobox', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  function setup(ui: React.ReactElement) {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    return { user, ...render(ui) };
  }

  it('debounces the search so typing a SKU is not one request per keystroke', async () => {
    const onSearchTermChange = vi.fn();
    const { user } = setup(<Harness onSearchTermChange={onSearchTermChange} />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'GREEN');

    onSearchTermChange.mockClear();
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(onSearchTermChange).toHaveBeenCalledWith('GREEN'));
    // One settled call for the whole word, not five.
    expect(onSearchTermChange).toHaveBeenCalledTimes(1);
  });

  it('shows matches with their SKU and selects on click', async () => {
    const { user } = setup(<Harness />);
    await user.click(screen.getByRole('combobox'));

    expect(await screen.findByText('V3-PLA-BAS-GREEN')).toBeInTheDocument();
    await user.click(screen.getByText('Landau PLA Matte 1.75mm 1kg — Green'));

    expect(screen.getByTestId('value')).toHaveTextContent('p2');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('selects with the keyboard alone', async () => {
    const { user } = setup(<Harness />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{ArrowDown}{Enter}');
    // First option is active initially; ArrowDown moves to the second.
    expect(screen.getByTestId('value')).toHaveTextContent('p2');
  });

  it('closes on Escape without choosing anything', async () => {
    const { user } = setup(<Harness />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('value')).toHaveTextContent('none');
  });

  it('drops the previous id as soon as the operator types over a selection', async () => {
    // Otherwise the field would read as a new search while still submitting the
    // old entity — the worst possible outcome for a stock adjustment.
    const { user } = setup(<Harness initial="p1" />);
    expect(screen.getByTestId('value')).toHaveTextContent('p1');

    await user.type(screen.getByRole('combobox'), 'PETG');
    expect(screen.getByTestId('value')).toHaveTextContent('none');
  });

  it('clears the selection with the clear button', async () => {
    const { user } = setup(<Harness initial="p1" />);
    await user.click(screen.getByRole('button', { name: /clear selection/i }));
    expect(screen.getByTestId('value')).toHaveTextContent('none');
  });

  it('shows the current selection rather than an empty box', async () => {
    setup(<Harness initial="p3" />);
    expect(screen.getByRole('combobox')).toHaveValue('Landau PETG 1.75mm 1kg — Red');
  });

  it('caps the list and says so, rather than implying it is complete', async () => {
    const many: ComboboxOption[] = Array.from({ length: 25 }, (_, i) => ({
      id: `x${i}`,
      label: `Product ${i}`,
    }));
    const { user } = setup(<Harness options={many} />);
    await user.click(screen.getByRole('combobox'));

    expect(screen.getAllByRole('option')).toHaveLength(MAX_VISIBLE_OPTIONS);
    expect(screen.getByText(/keep typing to narrow/i)).toBeInTheDocument();
  });

  it('tells the operator when nothing matched', async () => {
    const { user } = setup(<Harness options={[]} />);
    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(await screen.findByText(/no matches for/i)).toBeInTheDocument();
  });
});
