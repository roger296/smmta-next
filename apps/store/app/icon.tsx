/**
 * Favicon (`/icon`) — generated dynamically by Next's `ImageResponse`.
 * Renders a small "F" mark on the brand-paper background. 32×32 PNG.
 *
 * Using a dynamic icon route avoids shipping a pre-rendered binary in
 * the repo and keeps the source of truth in code.
 */
import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#18181b',
          color: '#fafaf7',
          fontSize: 24,
          fontWeight: 700,
          fontFamily: 'serif',
          letterSpacing: -1,
        }}
      >
        F
      </div>
    ),
    {
      ...size,
    },
  );
}
