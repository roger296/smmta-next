/**
 * Per-product Open Graph image (standalone product detail page).
 * Same layout as the group OG card but for a single variant.
 */
import { ImageResponse } from 'next/og';
import { getProductBySlug } from '@/lib/smmta';

export const runtime = 'edge';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Filament Store product card';

interface RouteParams {
  productSlug: string;
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

export default async function ProductOpenGraphImage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const { productSlug } = await params;

  let product;
  try {
    product = await getProductBySlug(productSlug);
  } catch {
    return brandedFallback('Filament Store');
  }

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
          {product.heroImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.heroImageUrl}
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
              {product.name}
            </div>
            {product.colour ? (
              <div
                style={{
                  fontSize: 28,
                  color: '#52525b',
                }}
              >
                {product.colour}
              </div>
            ) : null}
            {product.priceGbp ? (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 32,
                  fontWeight: 600,
                  color: '#18181b',
                }}
              >
                £{product.priceGbp}
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
