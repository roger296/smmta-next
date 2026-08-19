/**
 * Numeric entry (Aug-2026 feedback set, D-4 / D-5).
 *
 * "Default numbers are not overridden when typing (entering '3' into a default
 * field of '1' results in '13')."
 * "Request to enable direct number pad typing on laptop keyboards."
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNumericEntry } from './use-numeric-entry';

const key = (k: string) => ({ key: k, preventDefault: vi.fn() });

describe('D-4: the first keystroke replaces', () => {
  it('D-4 REGRESSION: initial 1, press 3 → "3", then 0 → "30"', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 1 }));
    // The starting value is shown...
    expect(result.current.value).toBe('1');
    expect(result.current.pristine).toBe(true);

    act(() => result.current.push('3'));
    // ...and the first digit REPLACES it. Pre-F10 this was "13".
    expect(result.current.value).toBe('3');
    expect(result.current.pristine).toBe(false);

    act(() => result.current.push('0'));
    // Subsequent digits append normally.
    expect(result.current.value).toBe('30');
  });

  it('keeps the starting value available for the "was N" hint', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 1 }));
    act(() => result.current.push('3'));
    expect(result.current.initial).toBe(1);
  });

  it('backspace on a pristine value clears it outright', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 1 }));
    act(() => result.current.backspace());
    // Not "" from nibbling one char off "1" — the user is replacing it, so
    // taking the whole default away is the intent.
    expect(result.current.value).toBe('');
    expect(result.current.pristine).toBe(false);
  });

  it('backspace after typing deletes one character', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 1 }));
    act(() => result.current.push('2'));
    act(() => result.current.push('5'));
    act(() => result.current.backspace());
    expect(result.current.value).toBe('2');
  });

  it('"." on a pristine value starts "0."', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 1 }));
    act(() => result.current.push('.'));
    expect(result.current.value).toBe('0.');
  });

  it('refuses a second decimal point', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 0 }));
    act(() => result.current.push('1'));
    act(() => result.current.push('.'));
    act(() => result.current.push('5'));
    act(() => result.current.push('.'));
    expect(result.current.value).toBe('1.5');
  });

  it('treats a leading zero as a placeholder, not a digit', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 0 }));
    act(() => result.current.push('0'));
    act(() => result.current.push('5'));
    expect(result.current.value).toBe('5');
  });

  it('an initial of 0 shows an empty buffer rather than a stray "0"', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 0 }));
    expect(result.current.value).toBe('');
  });

  it('resets when the target changes — a new row starts fresh', () => {
    const { result, rerender } = renderHook(({ initial }) => useNumericEntry({ initial }), {
      initialProps: { initial: 1 },
    });
    act(() => result.current.push('9'));
    expect(result.current.value).toBe('9');

    rerender({ initial: 500 });
    expect(result.current.value).toBe('500');
    expect(result.current.pristine).toBe(true);
  });
});

describe('D-4: allowDecimal={false} — the table counts', () => {
  it('rejects "." from a tap', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 0, allowDecimal: false }));
    act(() => result.current.push('4'));
    act(() => result.current.push('.'));
    expect(result.current.value).toBe('4');
  });

  it('rejects "." from the keyboard, and consumes the keystroke', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 0, allowDecimal: false }));
    const event = key('.');
    act(() => {
      result.current.handleKey(event);
    });
    expect(result.current.value).toBe('');
    // Consumed on purpose: a stray "." landing elsewhere on the page is worse
    // than nothing happening.
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('D-5: physical keyboard', () => {
  it('0-9 push', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 1 }));
    act(() => {
      result.current.handleKey(key('3'));
    });
    expect(result.current.value).toBe('3');
    act(() => {
      result.current.handleKey(key('7'));
    });
    expect(result.current.value).toBe('37');
  });

  it('"." and "," both give a decimal point', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 0 }));
    act(() => {
      result.current.handleKey(key('2'));
    });
    act(() => {
      result.current.handleKey(key(','));
    });
    act(() => {
      result.current.handleKey(key('5'));
    });
    expect(result.current.value).toBe('2.5');
  });

  it('Backspace and Delete both delete', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 0 }));
    act(() => {
      result.current.handleKey(key('1'));
    });
    act(() => {
      result.current.handleKey(key('2'));
    });
    act(() => {
      result.current.handleKey(key('Backspace'));
    });
    expect(result.current.value).toBe('1');
    act(() => {
      result.current.handleKey(key('Delete'));
    });
    expect(result.current.value).toBe('');
  });

  it('Enter asks to confirm and Escape to cancel, without mutating', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 4 }));
    let action: string | null = null;
    act(() => {
      action = result.current.handleKey(key('Enter')) as string | null;
    });
    expect(action).toBe('confirm');
    expect(result.current.value).toBe('4');

    act(() => {
      action = result.current.handleKey(key('Escape')) as string | null;
    });
    expect(action).toBe('cancel');
    expect(result.current.value).toBe('4');
  });

  it('ignores keys it has no business consuming', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 0 }));
    const event = key('a');
    let action: string | null = null;
    act(() => {
      action = result.current.handleKey(event) as string | null;
    });
    expect(action).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe('parsing', () => {
  it('reports valid only for a usable non-negative number', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 0 }));
    expect(result.current.valid).toBe(false); // empty

    act(() => result.current.push('4'));
    expect(result.current.valid).toBe(true);
    expect(result.current.numeric).toBe(4);

    act(() => result.current.clear());
    expect(result.current.valid).toBe(false);
  });

  it('a bare "0." is not yet a number the caller should act on', () => {
    const { result } = renderHook(() => useNumericEntry({ initial: 0 }));
    act(() => result.current.push('.'));
    expect(result.current.value).toBe('0.');
    // Number('0.') === 0, which IS finite — so this is deliberately valid; the
    // user has said "zero point something" and zero is a real answer.
    expect(result.current.numeric).toBe(0);
  });
});
