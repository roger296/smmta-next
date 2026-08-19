/**
 * Mount-once viewport plumbing for the venue layout (defects B-1, B-3).
 *
 * Two jobs, both of which have to happen for the whole layout rather than per
 * screen (mounting them per screen would fight itself when one venue screen
 * navigates to another):
 *
 *  1. **Publish the visual viewport** as `--tvv-height` / `--tvv-offset` so
 *     `.touch-app` sits exactly on the glass the keyboard has left, instead of
 *     being scrolled off the top of it.
 *  2. **Lock the background.** The document behind a full-screen fixed overlay
 *     still scrolled and rubber-banded on iOS, which is how a venue user could
 *     end up looking at the middle of an admin page they could not reach the
 *     top of.
 */
import * as React from 'react';
import { applyVisualViewportVars, useVisualViewport } from './use-visual-viewport';

export function TouchViewportLock(): null {
  const viewport = useVisualViewport();

  React.useEffect(() => {
    applyVisualViewportVars(document.documentElement, viewport);
  }, [viewport]);

  React.useEffect(() => {
    const { body, documentElement: root } = document;
    const previous = {
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
      rootOverscroll: root.style.overscrollBehavior,
      bodyPosition: body.style.position,
      bodyWidth: body.style.width,
    };

    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    root.style.overscrollBehavior = 'none';
    // `position: fixed` on the body is what actually stops iOS rubber-banding
    // the document under the overlay; width keeps it from collapsing.
    body.style.position = 'fixed';
    body.style.width = '100%';
    body.classList.add('touch-layout-active');

    return () => {
      body.style.overflow = previous.bodyOverflow;
      body.style.overscrollBehavior = previous.bodyOverscroll;
      root.style.overscrollBehavior = previous.rootOverscroll;
      body.style.position = previous.bodyPosition;
      body.style.width = previous.bodyWidth;
      body.classList.remove('touch-layout-active');
      applyVisualViewportVars(root, { height: 0, offsetTop: 0, supported: false });
    };
  }, []);

  return null;
}
