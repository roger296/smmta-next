/**
 * The keypad sheet, as a user meets it (Aug-2026 feedback set, D-4 / D-5).
 *
 * "Default numbers are not overridden when typing (entering '3' into a default
 * field of '1' results in '13')."
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeypadSheet } from './touch';

describe('D-4: typing over a default', () => {
  it('D-4 REGRESSION: tapping 3 into a default of 1 confirms 3, not 13', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<KeypadSheet title="Quantity" initial={1} onCancel={vi.fn()} onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: '3' }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onConfirm).toHaveBeenCalledWith(3);
  });

  it('shows the value being replaced, so nothing is lost', () => {
    render(<KeypadSheet title="Quantity" initial={1} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('was 1')).toBeInTheDocument();
  });

  it('the "was" hint goes once the value has been replaced', async () => {
    const user = userEvent.setup();
    render(<KeypadSheet title="Quantity" initial={1} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '3' }));
    expect(screen.queryByText('was 1')).not.toBeInTheDocument();
  });

  it('the display announces the value as it is typed', async () => {
    const user = userEvent.setup();
    render(<KeypadSheet title="Quantity" initial={0} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    const display = screen.getByRole('status');
    await user.click(screen.getByRole('button', { name: '2' }));
    await user.click(screen.getByRole('button', { name: '5' }));
    expect(display).toHaveTextContent('25');
  });
});

describe('D-5: the physical keyboard', () => {
  it('D-5: type 3, press Enter — the line reads 3', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<KeypadSheet title="Quantity" initial={1} onCancel={vi.fn()} onConfirm={onConfirm} />);

    await user.keyboard('3');
    expect(screen.getByRole('status')).toHaveTextContent('3');

    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledWith(3);
  });

  it('a multi-digit typed quantity round-trips', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<KeypadSheet title="Quantity" initial={1} onCancel={vi.fn()} onConfirm={onConfirm} />);

    await user.keyboard('250{Enter}');
    expect(onConfirm).toHaveBeenCalledWith(250);
  });

  it('a decimal quantity typed on the keyboard', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<KeypadSheet title="Quantity" initial={0} onCancel={vi.fn()} onConfirm={onConfirm} />);

    await user.keyboard('1.6{Enter}');
    expect(onConfirm).toHaveBeenCalledWith(1.6);
  });

  it('Backspace deletes', async () => {
    const user = userEvent.setup();
    render(<KeypadSheet title="Quantity" initial={0} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    await user.keyboard('45{Backspace}');
    expect(screen.getByRole('status')).toHaveTextContent('4');
  });

  it('Escape cancels without confirming', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<KeypadSheet title="Quantity" initial={1} onCancel={onCancel} onConfirm={onConfirm} />);

    await user.keyboard('7{Escape}');
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('D-5: allowDecimal={false} rejects "." from the keyboard too', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <KeypadSheet
        title="Tables"
        initial={0}
        allowDecimal={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    await user.keyboard('4.5{Enter}');
    // The "." never lands, so "45" is what was typed — not 4.5 tables.
    expect(onConfirm).toHaveBeenCalledWith(45);
  });

  it('the decimal key is disabled when decimals are not allowed', () => {
    render(
      <KeypadSheet title="Tables" initial={0} allowDecimal={false} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /decimal point/i })).toBeDisabled();
  });

  it('Save is refused while the buffer is empty', async () => {
    const user = userEvent.setup();
    render(<KeypadSheet title="Quantity" initial={4} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    await user.keyboard('{Backspace}');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });
});

describe('focus (D-5)', () => {
  it('returns focus to the control that opened the sheet', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open keypad</button>
          {open && (
            <KeypadSheet
              title="Quantity"
              initial={1}
              onCancel={() => setOpen(false)}
              onConfirm={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: /open keypad/i });
    await user.click(opener);
    await user.keyboard('{Escape}');

    expect(document.activeElement).toBe(opener);
  });
});
