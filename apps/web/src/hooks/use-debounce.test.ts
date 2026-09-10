import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDebounce, useDebouncedSearch } from './use-debounce';

describe('useDebounce', () => {
  it('returns initial value immediately', () => {
    const { result } = renderHook(() => useDebounce('hello', 300));
    expect(result.current).toBe('hello');
  });

  it('updates after delay', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
        initialProps: { value: 'a' },
      });
      rerender({ value: 'b' });
      expect(result.current).toBe('a');
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(result.current).toBe('a');
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current).toBe('b');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets timer on rapid changes', () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ value }) => useDebounce(value, 300), {
        initialProps: { value: 'a' },
      });
      rerender({ value: 'b' });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      rerender({ value: 'c' });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(result.current).toBe('a');
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(result.current).toBe('c');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useDebouncedSearch', () => {
  it('strips leading and trailing whitespace', () => {
    const { result } = renderHook(() => useDebouncedSearch('  V3-PLA-BAS-BLACK  ', 300));
    expect(result.current).toBe('V3-PLA-BAS-BLACK');
  });

  it('treats a whitespace-only term as empty', () => {
    // Callers pass `term || undefined`, so this is what stops a search for
    // spaces being sent as a real query that matches nothing.
    const { result } = renderHook(() => useDebouncedSearch('   ', 300));
    expect(result.current).toBe('');
  });

  it('leaves whitespace inside the term alone', () => {
    const { result } = renderHook(() => useDebouncedSearch('  matte black  ', 300));
    expect(result.current).toBe('matte black');
  });

  it('does not emit a new value when only trailing whitespace changes', () => {
    // Trimming before the debounce means typing a trailing space costs no
    // request at all. Trimming afterwards would still fire one.
    const { result, rerender } = renderHook(({ value }) => useDebouncedSearch(value, 300), {
      initialProps: { value: 'pla' },
    });
    const first = result.current;
    rerender({ value: 'pla ' });
    expect(result.current).toBe(first);
  });

  it('passes an already-clean term through unchanged', () => {
    const { result } = renderHook(() => useDebouncedSearch('petg', 300));
    expect(result.current).toBe('petg');
  });
});
