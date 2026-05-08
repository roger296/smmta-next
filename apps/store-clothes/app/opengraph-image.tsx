/**
 * Sitewide Open Graph fallback image (`/opengraph-image.png`).
 *
 * Used for the home page, /shop, /faq, and any other route that
 * doesn't supply its own segment-level `opengraph-image`. Plain
 * branded image — name, tagline, brand-paper background, steel-blue
 * accent matching the on-page hero treatment.
 *
 * 1200×630 PNG is the canonical OG card size.
 */
import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Filament Store — Premium 3D printer filament';

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
          padding: 72,
          backgroundColor: '#ECECE8',
          color: '#15161A',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              backgroundColor: '#15161A',
              color: '#ECECE8',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 32,
              fontWeight: 800,
              letterSpacing: -1,
            }}
          >
            F
          </div>
          <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: -0.5 }}>
            Filament Store
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
          }}
        >
          <div
            style={{
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: 4,
              textTransform: 'uppercase',
              color: '#3B5266',
            }}
          >
            1.75mm · 1kg · vacuum-sealed
          </div>
          <div
            style={{
              fontSize: 96,
              fontWeight: 800,
              letterSpacing: -3,
              lineHeight: 1.02,
              maxWidth: 1000,
            }}
          >
            Filament that prints first time.
          </div>
          <div style={{ fontSize: 28, color: '#6B6E76', maxWidth: 900 }}>
            PLA · PETG · ABS · ASA · TPU. Tight tolerances, fast UK delivery.
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
