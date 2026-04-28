/**
 * Apple touch icon (`/apple-icon`) — 180×180 PNG generated dynamically
 * via `ImageResponse`. Same brand mark as `/icon`, larger.
 */
import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
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
          fontSize: 120,
          fontWeight: 700,
          fontFamily: 'serif',
          letterSpacing: -4,
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
