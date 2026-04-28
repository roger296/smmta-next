/**
 * Sitewide Open Graph fallback image (`/opengraph-image.png`).
 *
 * Used for the home page, /shop, /faq, and any other route that
 * doesn't supply its own segment-level `opengraph-image`. Plain
 * branded image — name, tagline, brand-paper background.
 *
 * 1200×630 PNG is the canonical OG card size.
 */
import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Filament Store — Hand-finished LED filament lighting';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 64,
          backgroundColor: '#fafaf7',
          color: '#18181b',
          fontFamily: 'serif',
        }}
      >
        <div
          style={{
            fontSize: 36,
            fontWeight: 600,
            letterSpacing: -1,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              backgroundColor: '#18181b',
              color: '#fafaf7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 36,
              fontWeight: 700,
            }}
          >
            F
          </div>
          Filament Store
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ fontSize: 80, fontWeight: 600, letterSpacing: -2, lineHeight: 1.05 }}>
            Light, hand-finished.
          </div>
          <div style={{ fontSize: 32, color: '#52525b', maxWidth: 900 }}>
            A small, considered range of LED filament lamps. Designed in the UK.
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
