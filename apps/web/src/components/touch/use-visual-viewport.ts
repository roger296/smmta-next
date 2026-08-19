/**
 * Track the **visual** viewport (Aug-2026 feedback set, defect B-1).
 *
 * On iOS the layout viewport does not shrink when the keyboard opens — the
 * *visual* viewport does. A `position: fixed; inset: 0` element is sized
 * against the layout viewport, so it stays keyboard-height too tall, and
 * Safari scrolls the whole thing up to keep the focused field in view. The top
 * of the shell — the topbar, and the first line inputs under it — goes off the
 * top of the glass, with nothing left to scroll it back:
 *
 *   "Screen formatting cuts off the top of the page rendering any initial line
 *    inputs invisible and uneditable."
 *
 * Nothing in `apps/web/src` referenced `window.visualViewport` before this.
 *
 * The hook reports the visual viewport's height and how far it has been
 * scrolled away from the layout viewport's origin, so the shell can size and
 * offset itself to sit exactly on the visible glass. Where the API is absent
 * (older Safari, jsdom, a headless run) it reports the window's own size and
 * a zero offset, which is the correct degraded behaviour rather than a
 * special case.
 */
import * as React from 'react';

export interface VisualViewportState {
  /** Height of the visible area, in CSS pixels. */
  height: number;
  /** How far the visual viewport has been pushed down the layout viewport. */
  offsetTop: number;
  /** False when `window.visualViewport` is unavailable — we are guessing. */
  supported: boolean;
}

function read(): VisualViewportState {
  if (typeof window === 'undefined') {
    return { height: 0, offsetTop: 0, supported: false };
  }
  const vv = window.visualViewport;
  if (!vv) {
    return { height: window.innerHeight, offsetTop: 0, supported: false };
  }
  return {
    height: vv.height,
    // `pageTop` is where the visual viewport sits in the document; subtracting
    // the window's own scroll leaves the offset relative to the layout
    // viewport, which is what a fixed element needs.
    offsetTop: Math.max(0, vv.offsetTop),
    supported: true,
  };
}

export function useVisualViewport(): VisualViewportState {
  const [state, setState] = React.useState<VisualViewportState>(read);

  React.useEffect(() => {
    const update = () => setState(read());
    update();

    const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }
    // `resize` on window still matters: an orientation change fires it, and on
    // a browser with no visualViewport it is the only signal there is.
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);

    return () => {
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return state;
}

/**
 * The CSS custom properties `.touch-app` reads. Kept next to the hook so the
 * names cannot drift from `pwa-touch.css`.
 */
export const TVV_HEIGHT_VAR = '--tvv-height';
export const TVV_OFFSET_VAR = '--tvv-offset';

/** Publish the state as CSS variables on an element (usually the root). */
export function applyVisualViewportVars(el: HTMLElement | null, state: VisualViewportState): void {
  if (!el) return;
  if (!state.supported) {
    // Let the stylesheet's own `100dvh` fallback take over rather than
    // pinning a height we only guessed at.
    el.style.removeProperty(TVV_HEIGHT_VAR);
    el.style.removeProperty(TVV_OFFSET_VAR);
    return;
  }
  el.style.setProperty(TVV_HEIGHT_VAR, `${state.height}px`);
  el.style.setProperty(TVV_OFFSET_VAR, `${state.offsetTop}px`);
}
