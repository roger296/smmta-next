/**
 * Shared numeric-entry behaviour for the touch keypads (Aug-2026, D-4/D-5).
 *
 * ── D-4 ─────────────────────────────────────────────────────────────────────
 *
 * "Default numbers are not overridden when typing (entering '3' into a default
 * field of '1' results in '13')."
 *
 * `KeypadSheet` seeded its buffer with `String(initial)`, so the first keypress
 * **appended** to the pre-filled value. Every quantity a baker typed was
 * silently concatenated onto the default they were trying to replace.
 *
 * The fix is a "pristine" state: the starting value is shown, but the first
 * digit — from a tap **or** the keyboard — replaces it rather than extending
 * it. After that, digits append normally. The original is kept visible as
 * "was 1" so nothing is lost by the replacement.
 *
 * ── D-5 ─────────────────────────────────────────────────────────────────────
 *
 * "Request to enable direct number pad typing on laptop keyboards." There was
 * no `keydown` handling anywhere in either sheet. `KeypadSheet` and
 * `WastageSheet` had near-duplicate keypads, so the behaviour lives here once
 * rather than being fixed twice and drifting.
 */
import * as React from 'react';

export interface NumericEntry {
  /** What the display shows. */
  value: string;
  /** True until the user has committed to replacing the starting value. */
  pristine: boolean;
  /** The starting value, for the "was N" hint. */
  initial: number;
  /** Parsed value; `NaN` when the buffer is not a number. */
  numeric: number;
  /** True when `numeric` is a usable, non-negative number. */
  valid: boolean;
  push: (ch: string) => void;
  backspace: () => void;
  clear: () => void;
  /** Handle a physical keyboard event. Returns true when it was consumed. */
  handleKey: (event: {
    key: string;
    preventDefault?: () => void;
  }) => 'push' | 'backspace' | 'confirm' | 'cancel' | null;
}

export interface NumericEntryOptions {
  initial: number;
  allowDecimal?: boolean;
  maxLength?: number;
}

export function useNumericEntry({
  initial,
  allowDecimal = true,
  maxLength = 9,
}: NumericEntryOptions): NumericEntry {
  // `pristine` means "the buffer still holds the value we were given". The
  // first digit replaces; every one after that appends.
  const [value, setValue] = React.useState(() => (initial ? String(initial) : ''));
  const [pristine, setPristine] = React.useState(true);

  // A new target (a different row) resets both.
  React.useEffect(() => {
    setValue(initial ? String(initial) : '');
    setPristine(true);
  }, [initial]);

  const push = React.useCallback(
    (ch: string) => {
      if (ch === '.' && !allowDecimal) return;

      setValue((current) => {
        // D-4: the first keypress REPLACES. Typing 3 into a default of 1 gives
        // 3, not 13.
        const base = pristine ? '' : current;

        if (ch === '.') {
          if (base.includes('.')) return base;
          return base === '' ? '0.' : `${base}.`;
        }
        // A leading zero is a placeholder, not a digit: 0 then 5 is 5, not 05.
        if (base === '0') return ch;
        return (base + ch).slice(0, maxLength);
      });
      setPristine(false);
    },
    [allowDecimal, maxLength, pristine],
  );

  const backspace = React.useCallback(() => {
    setValue((current) => {
      // Backspace on a pristine value clears it outright rather than nibbling
      // the default one character at a time — the user is replacing it.
      if (pristine) return '';
      return current.slice(0, -1);
    });
    setPristine(false);
  }, [pristine]);

  const clear = React.useCallback(() => {
    setValue('');
    setPristine(false);
  }, []);

  const handleKey = React.useCallback<NumericEntry['handleKey']>(
    (event) => {
      const { key } = event;
      if (/^[0-9]$/.test(key)) {
        event.preventDefault?.();
        push(key);
        return 'push';
      }
      if (key === '.' || key === ',') {
        if (!allowDecimal) {
          // Consumed deliberately: swallowing the keystroke is clearer than
          // letting a "." land somewhere else on the page.
          event.preventDefault?.();
          return null;
        }
        event.preventDefault?.();
        push('.');
        return 'push';
      }
      if (key === 'Backspace' || key === 'Delete') {
        event.preventDefault?.();
        backspace();
        return 'backspace';
      }
      if (key === 'Enter') {
        event.preventDefault?.();
        return 'confirm';
      }
      if (key === 'Escape') {
        event.preventDefault?.();
        return 'cancel';
      }
      return null;
    },
    [allowDecimal, backspace, push],
  );

  const numeric = value === '' ? NaN : Number(value);
  const valid = value !== '' && Number.isFinite(numeric) && numeric >= 0;

  return { value, pristine, initial, numeric, valid, push, backspace, clear, handleKey };
}
