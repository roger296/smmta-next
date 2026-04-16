import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDebounce } from './use-debounce';

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
