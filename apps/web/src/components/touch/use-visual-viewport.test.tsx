/**
 * Visual-viewport tracking (Aug-2026 feedback set, defect B-1).
 *
 * Nothing in `apps/web/src` referenced `window.visualViewport` before F5,
 * which is why the iOS keyboard could scroll the fixed venue shell off the top
 * of the glass with no way back. These specs pin both halves: it responds to
 * the viewport moving, and it degrades safely where the API does not exist.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  applyVisualViewportVars,
  TVV_HEIGHT_VAR,
  TVV_OFFSET_VAR,
  useVisualViewport,
} from './use-visual-viewport';

interface StubViewport {
  height: number;
  offsetTop: number;
  addEventListener: (t: string, fn: () => void) => void;
  removeEventListener: (t: string, fn: () => void) => void;
}

function installStubViewport(): { stub: StubViewport; fire: (type: 'resize' | 'scroll') => void } {
  const listeners: Record<string, Array<() => void>> = { resize: [], scroll: [] };
  const stub: StubViewport = {
    height: 820,
    offsetTop: 0,
    addEventListener: (t, fn) => {
      (listeners[t] ??= []).push(fn);
    },
    removeEventListener: (t, fn) => {
      listeners[t] = (listeners[t] ?? []).filter((l) => l !== fn);
    },
  };
  Object.defineProperty(window, 'visualViewport', { value: stub, configurable: true, writable: true });
  return {
    stub,
    fire: (type) => {
      for (const fn of listeners[type] ?? []) fn();
    },
  };
}

afterEach(() => {
  Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true, writable: true });
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty(TVV_HEIGHT_VAR);
  document.documentElement.style.removeProperty(TVV_OFFSET_VAR);
});

describe('useVisualViewport', () => {
  it('reports the visual viewport when the API exists', () => {
    installStubViewport();
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.supported).toBe(true);
    expect(result.current.height).toBe(820);
    expect(result.current.offsetTop).toBe(0);
  });

  it('B-1: follows a shrinking, offset viewport — the keyboard case', () => {
    const { stub, fire } = installStubViewport();
    const { result } = renderHook(() => useVisualViewport());

    act(() => {
      stub.height = 500; // keyboard open
      stub.offsetTop = 180; // Safari has scrolled the visual viewport down
      fire('resize');
    });

    expect(result.current.height).toBe(500);
    expect(result.current.offsetTop).toBe(180);
  });

  it('responds to a scroll event too, not only resize', () => {
    const { stub, fire } = installStubViewport();
    const { result } = renderHook(() => useVisualViewport());
    act(() => {
      stub.offsetTop = 64;
      fire('scroll');
    });
    expect(result.current.offsetTop).toBe(64);
  });

  it('no-ops safely when the API is absent', () => {
    // `visualViewport` is undefined here (see afterEach) — older Safari, jsdom,
    // a headless run. Reporting the window size and flagging `supported: false`
    // is the correct degraded answer, not a crash and not a guess presented as
    // fact.
    const { result } = renderHook(() => useVisualViewport());
    expect(result.current.supported).toBe(false);
    expect(result.current.height).toBe(window.innerHeight);
    expect(result.current.offsetTop).toBe(0);
  });

  it('unsubscribes on unmount', () => {
    const { stub } = installStubViewport();
    const remove = vi.spyOn(stub, 'removeEventListener');
    const { unmount } = renderHook(() => useVisualViewport());
    unmount();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});

describe('applyVisualViewportVars', () => {
  it('publishes height and offset as CSS variables', () => {
    const el = document.documentElement;
    applyVisualViewportVars(el, { height: 500, offsetTop: 180, supported: true });
    expect(el.style.getPropertyValue(TVV_HEIGHT_VAR)).toBe('500px');
    expect(el.style.getPropertyValue(TVV_OFFSET_VAR)).toBe('180px');
  });

  it('removes the variables when unsupported, letting the CSS fallback win', () => {
    const el = document.documentElement;
    applyVisualViewportVars(el, { height: 500, offsetTop: 0, supported: true });
    applyVisualViewportVars(el, { height: 0, offsetTop: 0, supported: false });
    // Not "0px" — that would pin the shell to nothing. The stylesheet's own
    // 100dvh / 100vh fallback must take over instead.
    expect(el.style.getPropertyValue(TVV_HEIGHT_VAR)).toBe('');
  });

  it('tolerates a null element', () => {
    expect(() => applyVisualViewportVars(null, { height: 1, offsetTop: 0, supported: true })).not.toThrow();
  });
});
