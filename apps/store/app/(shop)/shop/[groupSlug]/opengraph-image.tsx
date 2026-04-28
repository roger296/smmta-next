/**
 * Per-group Open Graph image. Rendered on demand from the published
 * group's hero image + name + price-from.
 *
 * `<img>` inside ImageResponse fetches the source URL via Satori at
 * render time; if the API host is down we fall back to the branded
 * sitewide card. 1200×630 PNG.
 */
import { ImageResponse } from 'next/og';
import { getGroupBySlug } from '@/lib/smmta';
import { priceFromString } from '@/lib/seo/structured-data';

export const runtime = 'edge';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Filament Store product card';

interface RouteParams {
  groupSlug: string;
}

function brandedFallback(message: string) {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#fafaf7',
          color: '#18181b',
          fontSize: 56,
          fontFamily: 'serif',
          fontWeight: 600,
        }}
      >
        {message}
      </div>
    ),
    { ...size },
  );
}

export default async function GroupOpenGraphImage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const { groupSlug } = await params;

  let group;
  try {
    group = await getGroupBySlug(groupSlug);
  } catch {
    return brandedFallback('Filament Store');
  }

  const priceFrom = priceFromString(group);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          backgroundColor: '#fafaf7',
          fontFamily: 'serif',
        }}
      >
        <div
          style={{
            width: 600,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#e7e5e4',
          }}
        >
          {group.heroImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={group.heroImageUrl}
              alt=""
              width={600}
              height={630}
              style={{ width: 600, height: 630, objectFit: 'cover' }}
            />
          ) : (
            <div style={{ fontSize: 36, color: '#71717a' }}>No image</div>
          )}
        </div>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: 56,
            color: '#18181b',
          }}
        >
          <div
            style={{
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: '#71717a',
            }}
          >
            Filament Store
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div
              style={{
                fontSize: 64,
                fontWeight: 600,
                letterSpacing: -2,
                lineHeight: 1.05,
              }}
            >
              {group.name}
            </div>
            {group.shortDescription ? (
              <div
                style={{
                  fontSize: 26,
                  color: '#52525b',
                  lineHeight: 1.3,
                }}
              >
                {group.shortDescription}
              </div>
            ) : null}
            {priceFrom ? (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 32,
                  fontWeight: 600,
                  color: '#18181b',
                }}
              >
                From {priceFrom}
              </div>
            ) : null}
          </div>
          <div
            style={{
              fontSize: 22,
              color: '#71717a',
            }}
          >
            Hand-finished in the UK
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
